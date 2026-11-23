/**
 * @file src/catalog/reads.ts
 * @description BOUNDED catalog reads: keyset pages of pages and sources, the
 * ingest identity lookup, and counts.
 *
 * A page read opens the manifest, stats every catalogued directory once
 * (O(directories): the page directories, `sources/` and nested source dirs),
 * scans only the requested key range one block per run at a time, and stats
 * each RETURNED row's file. It never reads a body unless bodies were asked
 * for or a returned row's file changed since it was catalogued; then it reads
 * that file alone, re-projects the row for this response and reports it as a
 * stale row. Rows examined are capped (a filtered listing returns a partial
 * page with a cursor instead of scanning on). Nothing here writes: a stale
 * catalog is REPORTED (`catalog.state`), never repaired or bypassed by a
 * global scan.
 *
 * Order is UTF-16 code-unit key order (directory, then slug; or source id),
 * not the legacy locale order, and cursors are opaque keyset tokens that stay
 * valid across commits. A numeric legacy offset cursor is refused.
 */

import type { ListPagesOptions, ListPagesResult, ListPagesWarning, Page } from "../pages/list.js";
import type { SegmentStore } from "../segments/store.js";
import { isSourceExcluded, type SourceSelection } from "../sources/selection.js";
import type { ListSourcesOptions, SourceRecord } from "../sources/source-record.js";
import { SOURCES_DIR } from "../utils/constants.js";
import {
  identityPrefix, PAGE_DIRECTORIES, parsePageKey, RACY_WINDOW_MS, SAMPLE_SIZE, type CatalogMeta, type DirStamp, type FileStamp, type PageRowV1,
} from "./contracts.js";
import { dirStamp, fileStamp, readCatalogFile, sameStamp } from "./files.js";
import { catalogMetaOf } from "./meta.js";
import { readSourceIdentity, sourceIdentityUnavailable } from "./source-admission.js";
import { asPageRow, asSourceRow, bodyOf, pageFromRow, pageRowFrom, sourceFromRow, sourceRowFrom, stampOfRow } from "./rows.js";

/** Rows returned when the caller states no limit, and the most it may ask for. */
const DEFAULT_INDEXED_LIMIT = 1000;
/** Rows examined per row returned before a filtered listing stops early. */
const SCAN_FACTOR = 10;

/** What a listing says about the catalog it was served from. */
export interface CatalogListingNote {
  /** `reconciling`: an explicit reconciliation was interrupted; rows are partly updated and counts are not current until it reruns. */
  readonly state: "fresh" | "stale" | "unverified" | "building" | "reconciling";
  /** A bounded sample of stale directories; `staleDirectoryCount` is the full count. */
  readonly staleDirectories?: readonly string[];
  readonly staleDirectoryCount?: number;
  readonly staleRows?: { readonly count: number; readonly sample: readonly string[] };
  readonly uncatalogued?: { readonly count: number; readonly sample: readonly string[] };
  readonly scanBudgetExhausted?: true;
  readonly defaultLimitApplied?: true;
}

/** Encode a keyset cursor. */
function encodeCursor(key: string): string {
  return `k1.${Buffer.from(key, "utf8").toString("base64url")}`;
}

/** Decode a keyset cursor for keys under `prefix`; anything else (including a numeric offset) is refused. */
function decodeCursor(cursor: string | undefined, prefix: string, label: string): string | undefined {
  if (cursor === undefined) return undefined;
  const key = cursor.startsWith("k1.") ? Buffer.from(cursor.slice(3), "base64url").toString("utf8") : "";
  if (!key.startsWith(prefix)) throw new Error(`invalid ${label} cursor: ${cursor}`);
  return key;
}

/** Milliseconds of a nanosecond stamp. */
function millis(stamp: FileStamp): number {
  return Number(BigInt(stamp.mtimeNs) / 1_000_000n);
}

/** Stale rows or directories met while serving one listing: a count and a bounded sample. */
export class StaleRows {
  count = 0;
  readonly sample: string[] = [];
  private readonly seen = new Set<string>();

  /** Note one stale path once, even when independent windows examine the same row. */
  note(relPath: string): void {
    if (this.seen.has(relPath)) return;
    this.seen.add(relPath);
    this.count += 1;
    if (this.sample.length < SAMPLE_SIZE) this.sample.push(relPath);
  }
}

/** Directory staleness under `prefix`: every recorded directory row stat'd once (O(directories)), no file scan. */
async function directoryFreshness(root: string, store: SegmentStore, prefix: string): Promise<{ stale: StaleRows; racy: boolean }> {
  const stale = new StaleRows();
  let racy = false;
  for await (const row of store.scan({ prefix })) {
    const relDir = row.k.slice(2);
    const recorded = stampOfRow(row.k, row.v) as DirStamp | null;
    const now = await dirStamp(root, relDir, store.counters);
    if (!sameStamp(now, recorded)) stale.note(relDir);
    else if (now !== null && recorded !== null && Math.abs(millis(now) - recorded.capturedAtMs) < RACY_WINDOW_MS) racy = true;
  }
  return { stale, racy };
}

/** The freshness note of the catalog: every catalogued directory compared with its recorded stamp (O(directories)). */
export function catalogFreshness(root: string, store: SegmentStore): Promise<CatalogListingNote> {
  return freshness(root, store, catalogMetaOf(store));
}

/** The freshness note of a listing: every catalogued directory compared with its recorded stamp. */
async function freshness(root: string, store: SegmentStore, meta: CatalogMeta): Promise<CatalogListingNote> {
  if (meta.phase !== "ready") return { state: meta.phase };
  const { stale, racy } = await directoryFreshness(root, store, "d:");
  const uncatalogued = meta.uncatalogued.count > 0 ? { uncatalogued: meta.uncatalogued } : {};
  if (stale.count > 0) return { state: "stale", staleDirectories: stale.sample, staleDirectoryCount: stale.count, ...uncatalogued };
  return { state: racy ? "unverified" : "fresh", ...uncatalogued };
}

/** The live state of one returned row's file: unchanged, re-projected text, or gone. */
type RowFile = { kind: "same" } | { kind: "changed"; text: string; stamp: FileStamp } | { kind: "gone" };

/** Stat a returned row's file and, only if it changed, read it. */
async function rowFile(root: string, store: SegmentStore, relPath: string, stamp: FileStamp): Promise<RowFile> {
  const now = await fileStamp(root, relPath, store.counters);
  if (now === null) return { kind: "gone" };
  if (sameStamp(now, stamp)) return { kind: "same" };
  const text = await readCatalogFile(root, relPath, store.counters);
  return text === null ? { kind: "gone" } : { kind: "changed", text, stamp: now };
}

/** One window of a keyset listing. */
export interface Window<T> { items: T[]; nextAfter?: string; budgetExhausted: boolean }

/** Scan keys under `prefix` after `after`, accepting up to `limit` items within the examined-row budget. */
export async function scanWindow<T>(store: SegmentStore, prefix: string, after: string | undefined, limit: number, accept: (key: string, value: unknown) => Promise<T | null>): Promise<Window<T>> {
  const items: T[] = [];
  let last: string | undefined;
  let examined = 0;
  let stop: Omit<Window<T>, "items"> = { budgetExhausted: false };
  for await (const row of store.scan({ prefix, ...(after === undefined ? {} : { after }) })) {
    if (items.length >= limit || examined >= limit * SCAN_FACTOR) {
      stop = { nextAfter: last, budgetExhausted: items.length < limit };
      break;
    }
    examined += 1;
    last = row.k;
    const item = await accept(row.k, row.v);
    if (item !== null) items.push(item);
  }
  store.counters.rowsReturned += items.length;
  return { items, ...stop };
}

/**
 * The effective limit: a finite limit of at least 1 is floored to an integer
 * and capped at {@link DEFAULT_INDEXED_LIMIT}; anything else (absent, zero,
 * negative, fractional below 1, NaN, infinite) takes the default, reported.
 */
export function effectiveLimit(limit: number | undefined): { limit: number; defaulted: boolean } {
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 1) return { limit: Math.min(Math.floor(limit), DEFAULT_INDEXED_LIMIT), defaulted: false };
  return { limit: DEFAULT_INDEXED_LIMIT, defaulted: true };
}

/** The note for one served listing. */
function listingNote(base: CatalogListingNote, stale: StaleRows, window: Window<unknown>, defaulted: boolean): CatalogListingNote {
  // A returned row whose file changed or vanished makes the catalog stale even when every directory stamp matched.
  const state = stale.count > 0 && (base.state === "fresh" || base.state === "unverified") ? "stale" : base.state;
  return {
    ...base, state,
    ...(stale.count > 0 ? { staleRows: { count: stale.count, sample: stale.sample } } : {}),
    ...(window.budgetExhausted ? { scanBudgetExhausted: true as const } : {}),
    ...(defaulted && window.nextAfter !== undefined ? { defaultLimitApplied: true as const } : {}),
  };
}

/** A returned row checked against its file: as stored, or re-projected from the changed file (with its text). */
interface CurrentRow<R> { readonly row: R; readonly changedText?: string }

/** Check a returned row against its file: `null` when the file is gone; a changed file is re-projected. Both are noted stale. */
async function currentRow<R extends { stamp: FileStamp }>(
  root: string, store: SegmentStore, relPath: string, row: R, reproject: (text: string, stamp: FileStamp) => R, stale: StaleRows,
): Promise<CurrentRow<R> | null> {
  const file = await rowFile(root, store, relPath, row.stamp);
  if (file.kind === "same") return { row };
  stale.note(relPath);
  return file.kind === "gone" ? null : { row: reproject(file.text, file.stamp), changedText: file.text };
}

/** The body of a served row: the changed file's text already read, else one confined read; `null` when it cannot be read. */
async function servedBody(root: string, store: SegmentStore, relPath: string, current: CurrentRow<unknown>): Promise<string | null> {
  const text = current.changedText ?? await readCatalogFile(root, relPath, store.counters);
  return text === null ? null : bodyOf(text);
}

/** Whether a page row is hidden by the listing's archived/orphaned options. */
function hiddenPage(row: PageRowV1, options: ListPagesOptions): boolean {
  return (row.orphaned && options.includeOrphaned !== true) || (row.archived && options.includeArchived !== true);
}

/** The page a returned page row serves, after checking its file. */
async function servedPage(root: string, store: SegmentStore, key: string, value: unknown, options: ListPagesOptions, stale: StaleRows): Promise<Page | null> {
  const { dir, slug } = parsePageKey(key);
  const relPath = `${PAGE_DIRECTORIES.find(([name]) => name === dir)![1]}/${slug}.md`;
  const current = await currentRow(root, store, relPath, asPageRow(value, key), (text, stamp) => pageRowFrom(dir, slug, text, stamp), stale);
  if (current === null || hiddenPage(current.row, options)) return null;
  if (options.includeBody !== true) return pageFromRow(dir, slug, current.row);
  const body = await servedBody(root, store, relPath, current);
  return body === null ? null : pageFromRow(dir, slug, current.row, body);
}

/** One keyset listing's request: its key prefix, the method named in cursor errors, and the caller's cursor and limit. */
interface KeysetRequest { readonly prefix: "p:" | "s:"; readonly method: string; readonly cursor?: string; readonly limit?: number }

/** One keyset listing over `request.prefix`: the served items, the next cursor and the freshness note. Bounded. */
async function keysetListing<T>(
  root: string, store: SegmentStore, request: KeysetRequest, serve: (key: string, value: unknown, stale: StaleRows) => Promise<T | null>,
): Promise<{ items: T[]; cursor?: string; note: CatalogListingNote }> {
  const after = decodeCursor(request.cursor, request.prefix, request.method);
  const base = await freshness(root, store, catalogMetaOf(store));
  const { limit, defaulted } = effectiveLimit(request.limit);
  const stale = new StaleRows();
  const window = await scanWindow(store, request.prefix, after, limit, (key, value) => serve(key, value, stale));
  const cursor = window.nextAfter === undefined ? {} : { cursor: encodeCursor(window.nextAfter) };
  return { items: window.items, ...cursor, note: listingNote(base, stale, window, defaulted) };
}

/** A keyset page of pages from the catalog. Bounded; see the file comment. */
export async function listPagesIndexed(root: string, store: SegmentStore, options: ListPagesOptions = {}): Promise<ListPagesResult & { catalog: CatalogListingNote }> {
  const request: KeysetRequest = { prefix: "p:", method: "listPages", cursor: options.cursor, limit: options.limit };
  const { items, cursor, note } = await keysetListing(root, store, request, (key, value, stale) => servedPage(root, store, key, value, options, stale));
  const warnings: ListPagesWarning[] = note.state === "fresh" ? [] : [{ code: `catalog-${note.state}`, message: catalogMessage(note) }];
  return { pages: items, ...(cursor === undefined ? {} : { cursor }), ...(warnings.length > 0 ? { warnings } : {}), catalog: note };
}

/**
 * `result` with `stale` (entity rows re-read for the profile block) folded
 * into its catalog note and warning: one note for the whole listing.
 */
export function withExtraStaleRows<R extends { catalog: CatalogListingNote; warnings?: ListPagesWarning[] }>(result: R, stale: StaleRows): R {
  if (stale.count === 0) return result;
  const prior = result.catalog.staleRows;
  const state = result.catalog.state === "fresh" || result.catalog.state === "unverified" ? "stale" : result.catalog.state;
  const catalog: CatalogListingNote = { ...result.catalog, state, staleRows: { count: (prior?.count ?? 0) + stale.count, sample: [...(prior?.sample ?? []), ...stale.sample].slice(0, SAMPLE_SIZE) } };
  const warnings = [...(result.warnings ?? []).filter((warning) => !warning.code.startsWith("catalog-")), { code: `catalog-${state}`, message: catalogMessage(catalog) }];
  return { ...result, catalog, warnings };
}

/** A one-line operator message for a non-fresh catalog. */
export function catalogMessage(note: CatalogListingNote): string {
  if (note.state === "stale" && note.staleDirectories !== undefined) return `the catalog predates changes in ${note.staleDirectories.join(", ")}; run \`llmwiki catalog sync\` to reconcile`;
  if (note.state === "stale") return `${note.staleRows?.count ?? 0} listed file(s) changed since they were catalogued (re-read for this response); run \`llmwiki catalog sync\` to reconcile`;
  if (note.state === "building") return "the catalog has not finished its first reconciliation";
  if (note.state === "reconciling") return "a catalog reconciliation was interrupted: rows are partly updated and counts are not current; run `llmwiki catalog sync` to finish it";
  return "a catalogued directory changed within the racy window of its last reconciliation; run `llmwiki catalog sync` to verify";
}

/** Whether `id` is listed under `selection` (its recursion and exclusions, applied at read time). */
function sourceSelected(id: string, selection: SourceSelection, applyExclusions: boolean): boolean {
  if (!selection.recursive && id.includes("/")) return false;
  return !applyExclusions || !isSourceExcluded(id, selection);
}

/** The record a returned source row serves, after checking its file. */
async function servedSource(root: string, store: SegmentStore, key: string, value: unknown, includeBody: boolean, stale: StaleRows): Promise<SourceRecord | null> {
  const id = key.slice(2);
  const relPath = `${SOURCES_DIR}/${id}`;
  const current = await currentRow(root, store, relPath, asSourceRow(value, key), (text, stamp) => sourceRowFrom(id, text, stamp), stale);
  if (current === null) return null;
  if (!includeBody) return sourceFromRow(id, current.row);
  const body = await servedBody(root, store, relPath, current);
  return body === null ? null : sourceFromRow(id, current.row, body);
}

/** A keyset page of sources from the catalog, honouring the source selection. */
export async function listSourcesIndexed(
  root: string, store: SegmentStore, selection: SourceSelection, options: ListSourcesOptions = {},
): Promise<{ sources: SourceRecord[]; cursor?: string; catalog: CatalogListingNote }> {
  const request: KeysetRequest = { prefix: "s:", method: "listSources", cursor: options.cursor, limit: options.limit };
  const { items, cursor, note } = await keysetListing(root, store, request, (key, value, stale) =>
    (sourceSelected(key.slice(2), selection, true) ? servedSource(root, store, key, value, options.includeBody === true, stale) : Promise.resolve(null)));
  return { sources: items, ...(cursor === undefined ? {} : { cursor }), catalog: note };
}

/**
 * The source file holding identity `source`, or `null`. Candidates come from
 * the identity index under that identity's prefix, in id order (the order
 * the legacy scan used); each candidate's FILE is read to confirm it still
 * holds the identity, until one does. A unique live identity costs one index
 * probe and one file read; stale or duplicate candidates cost one read each
 * (O(candidates for this identity), never a global scan). Compile exclusions
 * are ignored (recursion kept). Unreadable candidates or known uncatalogued
 * inventory cannot prove absence; the caller must reconcile or repair them.
 */
export async function lookupSourceIdentity(root: string, store: SegmentStore, selection: SourceSelection, source: string): Promise<string | null> {
  const prefix = identityPrefix(source);
  for await (const row of store.scan({ prefix })) {
    const id = row.k.slice(prefix.length);
    if (!sourceSelected(id, selection, false)) continue;
    if (await readSourceIdentity(root, id, store.counters) === source) return id;
  }
  if (catalogMetaOf(store).uncatalogued.count > 0) throw sourceIdentityUnavailable();
  return null;
}

/** Whether the catalog's record of every source directory is current (one stat per source directory). */
export async function sourcesFresh(root: string, store: SegmentStore): Promise<boolean> {
  if (catalogMetaOf(store).phase !== "ready") return false;
  return (await directoryFreshness(root, store, `d:${SOURCES_DIR}`)).stale.count === 0;
}

/** Counts and freshness, from the manifest and three stats. */
export async function catalogCountsIndexed(root: string, store: SegmentStore): Promise<{ counts: CatalogMeta["counts"]; catalog: CatalogListingNote }> {
  const meta = catalogMetaOf(store);
  return { counts: meta.counts, catalog: await freshness(root, store, meta) };
}
