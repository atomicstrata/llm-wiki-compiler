/**
 * @file src/catalog/entity-reads.ts
 * @description The BOUNDED additive `profile` block of an indexed listing for
 * a custom profile, served from the typed entity catalog
 * (`./entity-rows.ts`).
 *
 * CONTRACT, the incumbent block's: `entityPages` (the public views, sorted
 * here in code-unit KEY order, `e:<type>/<stem>`: the indexed route's
 * documented order), `total`, `cursor` (continue with `profileCursor`), and
 * `problems`/`problemTotal`/`problemCursor` (continue with `problemCursor`),
 * the two windows independent and each sized by the listing's `limit`
 * (default and maximum 1000), and each window examines a bounded number of
 * rows before it stops with a continuation cursor (`scanBudgetExhausted` in
 * the listing's catalog note). Field-violation pages are listed WITH their
 * problems; pages with an invalid identity are not listed.
 *
 * IDENTITY. Cursors are opaque keyset tokens bound to the typed catalog's id;
 * a cursor from another catalog (or an offset cursor) is refused with
 * `catalog_cursor_stale`. A catalog built for another profile refuses with
 * `catalog_profile_stale` (run `llmwiki catalog sync`).
 *
 * FRESHNESS. Every returned row's file is stat'd (with or without bodies). A
 * changed file is re-projected LIVE through the incumbent collector for this
 * response and counted as a stale row; if its identity is now invalid it is
 * left out. Totals stay the catalogued totals, and the listing's catalog note
 * marks them stale. Nothing here writes.
 */

import type { ListPagesOptions, ListPagesProfileBlock } from "../pages/list.js";
import type { EntityPageView, EntityProblemView, EntityTypeDef, LoadedProfile } from "../profile/types.js";
import { MAX_KEY_CHARS } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { asEntityDirRow, asEntityFileRow, collectOne, isEntityDirKey, parseEntityKey } from "./entity-rows.js";
import { fileStamp, sameStamp } from "./files.js";
import { catalogMetaOf } from "./meta.js";
import { effectiveLimit, scanWindow, type StaleRows } from "./reads.js";

/** A typed-catalog listing refusal with a stable code; nothing was read past it. */
export class CatalogTypedError extends Error {
  constructor(readonly code: "catalog_profile_stale" | "catalog_cursor_stale" | "catalog_typed_preparing", message: string) {
    super(`${code}: ${message}`);
    this.name = "CatalogTypedError";
  }
}

/** A position in the entity rows: after a key, or within one row's problem list. */
interface EntityPosition { readonly k: string; readonly i: number }

/** Encode a cursor bound to `catalogId`. */
function encode(catalogId: string, position: EntityPosition): string {
  return `t1.${Buffer.from(JSON.stringify({ c: catalogId, ...position }), "utf8").toString("base64url")}`;
}

/**
 * The longest typed cursor decoded. A minted one holds one key (at most
 * MAX_KEY_CHARS code units, each up to 6 characters once JSON-escaped), the
 * catalog id and an index, base64url-encoded (4/3): 12 * MAX_KEY_CHARS covers
 * every minted cursor with room to spare.
 */
const MAX_CURSOR_CHARS = 12 * MAX_KEY_CHARS;

/** The JSON object a `t1.` cursor carries, or an empty object for anything else (too long, not JSON, or not an object). */
function cursorObject(cursor: string): { c?: unknown; k?: unknown; i?: unknown } {
  if (!cursor.startsWith("t1.") || cursor.length > MAX_CURSOR_CHARS) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Decode a cursor; anything not minted by this typed catalog is refused. */
function decode(cursor: string | undefined, catalogId: string, label: string): EntityPosition | undefined {
  if (cursor === undefined) return undefined;
  const value = cursorObject(cursor);
  if (value.c !== catalogId || typeof value.k !== "string" || !value.k.startsWith("e:") || !Number.isSafeInteger(value.i) || (value.i as number) < 0) {
    throw new CatalogTypedError("catalog_cursor_stale", `the ${label} cursor was not issued by this typed catalog; restart the listing without it`);
  }
  return { k: value.k, i: value.i as number };
}

/** The project-relative file of an entity file key. */
function relPathOf(loaded: LoadedProfile, key: string): string | null {
  const { type, stem } = parseEntityKey(key);
  const def = loaded.profile.entities[type] as EntityTypeDef | undefined;
  return def === undefined ? null : `${def.directory}/${stem}.md`;
}

/** The page of entity `key` projected from its file now (with its body only when asked), or `null`. */
async function liveView(root: string, loaded: LoadedProfile, key: string, includeBody: boolean): Promise<EntityPageView | null> {
  const { type, stem } = parseEntityKey(key);
  const live = (await collectOne(root, loaded, type, `${stem}.md`)).page;
  if (live === null || includeBody) return live;
  const { body: _body, ...view } = live;
  return view;
}

/** The view one returned file row serves after checking its file; `null` when it is not (or no longer) a listable page. */
async function servedView(root: string, store: SegmentStore, loaded: LoadedProfile, key: string, value: unknown, includeBody: boolean, stale: StaleRows): Promise<EntityPageView | null> {
  const row = asEntityFileRow(value, key);
  const relPath = relPathOf(loaded, key);
  if (row.page === null || relPath === null) return null;
  const now = await fileStamp(root, relPath, store.counters);
  const changed = now === null || !sameStamp(now, row.stamp);
  if (changed) stale.note(relPath);
  if (now === null) return null;
  if (!changed && !includeBody && row.page !== "live") return { ...row.page };
  return liveView(root, loaded, key, includeBody);
}

/** Entity rows a problem window examines per problem it may return, before it stops with a continuation. */
const PROBLEM_SCAN_FACTOR = 10;

/**
 * One window of the flattened problems from `start`: at most `limit`
 * problems, examining at most `limit * PROBLEM_SCAN_FACTOR` entity rows (a
 * healthy catalog with few problems is not scanned whole). Returns where the
 * next window starts, and whether the row budget, not the limit, stopped it.
 */
async function problemWindow(root: string, store: SegmentStore, loaded: LoadedProfile, stale: StaleRows, start: EntityPosition | undefined, limit: number): Promise<{ items: EntityProblemView[]; next?: EntityPosition; budgetExhausted: boolean }> {
  const items: EntityProblemView[] = [];
  let examined = 0;
  for await (const row of store.scan({ prefix: "e:", ...(start === undefined ? {} : { from: start.k }) })) {
    const from = firstProblemOf(row.k, start);
    if (examined >= limit * PROBLEM_SCAN_FACTOR) return { items, next: { k: row.k, i: from }, budgetExhausted: true };
    examined += 1;
    const stopped = takeProblems(await rowProblems(root, store, loaded, stale, row.k, row.v), from, limit, items);
    if (stopped !== null) return { items, next: { k: row.k, i: stopped }, budgetExhausted: false };
  }
  return { items, budgetExhausted: false };
}

/** Where a window starts within `key`'s problems: the start's index on its own row, else the first. */
const firstProblemOf = (key: string, start: EntityPosition | undefined): number => (start !== undefined && key === start.k ? start.i : 0);

/** The current problems of one bounded-scan entity row (directory or file). */
async function rowProblems(root: string, store: SegmentStore, loaded: LoadedProfile, stale: StaleRows, key: string, value: unknown): Promise<readonly EntityProblemView[]> {
  if (isEntityDirKey(key)) return asEntityDirRow(value, key).problems;
  const row = asEntityFileRow(value, key);
  const relPath = relPathOf(loaded, key);
  if (relPath === null) return row.problems;
  const now = await fileStamp(root, relPath, store.counters);
  if (now !== null && sameStamp(now, row.stamp)) return row.problems;
  stale.note(relPath);
  if (now === null) return [];
  const { type, stem } = parseEntityKey(key);
  return (await collectOne(root, loaded, type, `${stem}.md`)).problems;
}

/** Append `problems` from `from` to `items` until it holds `limit`; returns the index it stopped at, or `null` when it took them all. */
function takeProblems(problems: readonly EntityProblemView[], from: number, limit: number, items: EntityProblemView[]): number | null {
  for (let at = from; at < problems.length; at += 1) {
    if (items.length >= limit) return at;
    items.push(problems[at]!);
  }
  return null;
}

/** What serving a profile block noted for the listing's catalog note. */
export interface EntityListingNotes {
  readonly stale: StaleRows;
  /** Set when either window stopped on its examined-row budget rather than its limit. */
  budgetExhausted: boolean;
}

/** The additive profile block of an indexed listing for `loaded`, from the typed catalog in `store`. */
export async function profileBlockIndexed(root: string, store: SegmentStore, loaded: LoadedProfile, options: ListPagesOptions, notes: EntityListingNotes): Promise<ListPagesProfileBlock> {
  const stale = notes.stale;
  const typed = catalogMetaOf(store).typed;
  if (typed === undefined || typed.profileDigest !== loaded.digest) throw new CatalogTypedError("catalog_profile_stale", "the typed entity catalog was not built for the effective profile; run `llmwiki catalog sync`");
  const { limit } = effectiveLimit(options.limit);
  const after = decode(options.profileCursor, typed.catalogId, "profile");
  const pages = await scanWindow(store, "e:", after?.k, limit, (key, value) =>
    (isEntityDirKey(key) ? Promise.resolve(null) : servedView(root, store, loaded, key, value, options.includeBody === true, stale)));
  const problems = await problemWindow(root, store, loaded, stale, decode(options.problemCursor, typed.catalogId, "problem"), limit);
  notes.budgetExhausted = notes.budgetExhausted || pages.budgetExhausted || problems.budgetExhausted;
  return {
    entityPages: pages.items, total: typed.pages,
    ...(pages.nextAfter === undefined ? {} : { cursor: encode(typed.catalogId, { k: pages.nextAfter, i: 0 }) }),
    ...(typed.problems > 0 || problems.items.length > 0 ? { problems: problems.items, problemTotal: typed.problems } : {}),
    ...(problems.next === undefined ? {} : { problemCursor: encode(typed.catalogId, problems.next) }),
  };
}
