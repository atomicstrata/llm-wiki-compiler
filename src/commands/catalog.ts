/**
 * @file src/commands/catalog.ts
 * @description `llmwiki catalog status|sync|pages|sources`.
 *
 * `status` is read-only and bounded. `verify` fully verifies every indexed
 * store (it changes no store authority, O(stored data); exit 3 when any
 * fails; like every indexed read it registers this process's reader lease
 * under `.llmwiki/indexed-readers`). `sync` reconciles an active
 * `local-indexed` catalog with the files under the project lock (explicit
 * O(files) work). `pages` and `sources` print one keyset page through the
 * same route the SDK listings use (the catalog when indexed, the incumbent
 * listing otherwise). Exit codes: 0 done, 2 refused with nothing changed.
 */

import { CatalogNotActiveError, catalogStatus, catalogSync, catalogVerify } from "../catalog/facade.js";
import { routedListPages, routedListSources } from "../catalog/routes.js";
import { CatalogTypedError } from "../catalog/entity-reads.js";
import { catalogMessage, type CatalogListingNote } from "../catalog/reads.js";
import type { ListPagesProfileBlock } from "../pages/list.js";
import type { IndexedStorageV1 } from "../indexed/verify.js";
import * as output from "../utils/output.js";

const CATALOG_JSON_VERSION = 1;
const EXIT_OK = 0;
/** Refused with nothing changed (shared by the maintenance commands). */
export const EXIT_REFUSED = 2;
const EXIT_BLOCKED = 3;

/** Options of every catalog command. */
export interface CatalogCommandOptions {
  readonly json?: boolean;
  readonly cursor?: string;
  readonly limit?: string;
  readonly includeArchived?: boolean;
  readonly includeOrphaned?: boolean;
  /** `catalog pages`: continue the custom profile's entity pages after this typed cursor. */
  readonly profileCursor?: string;
  /** `catalog pages`: continue the custom profile's problems after this typed cursor. */
  readonly problemCursor?: string;
  /** `catalog pages`: include each entity page's body. */
  readonly includeBody?: boolean;
}

/** Print one envelope (JSON) or its human lines, returning `code`. */
export function emit(command: string, body: Record<string, unknown>, lines: string[], options: CatalogCommandOptions, code = EXIT_OK): number {
  if (options.json) process.stdout.write(`${JSON.stringify({ version: CATALOG_JSON_VERSION, command, ok: code === EXIT_OK, ...body }, null, 2)}\n`);
  else for (const line of lines) output.status(code === EXIT_OK ? "*" : "!", line);
  return code;
}

/** Parse `--limit`: a positive whole number, or absent. */
function parseLimit(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,6}$/.test(text.trim()) || Number(text) < 1) throw new Error("--limit must be a positive whole number");
  return Number(text);
}

/** Human warning lines for a listing's catalog note: staleness, stale rows, a partial page. */
function noteLines(note: CatalogListingNote | undefined): string[] {
  if (note === undefined) return [];
  const lines = note.state === "fresh" ? [] : [`Warning: ${catalogMessage(note)}`];
  if (note.staleRows !== undefined) lines.push(`Warning: ${note.staleRows.count} listed file(s) changed since they were catalogued and were re-read for this page`);
  if (note.scanBudgetExhausted === true) lines.push("Warning: this page is partial (filtered rows reached the scan budget); continue with the cursor");
  if (note.defaultLimitApplied === true) lines.push("Note: the default page size applied; continue with the cursor");
  return lines;
}

/** `llmwiki catalog status`. */
export async function catalogStatusCommand(options: CatalogCommandOptions = {}): Promise<number> {
  const status = await catalogStatus(process.cwd());
  const lines = status.active
    ? [`Catalog: ${status.catalog?.state}`, ...noteLines(status.catalog), `Pages: ${status.counts!.concepts} concepts, ${status.counts!.queries} queries; sources: ${status.counts!.sources}`]
    : ["Catalog: not active (the project's architecture is not local-indexed)"];
  return emit("catalog status", { ...status }, lines, options);
}

/** The refusal envelope of a catalog command on a project that is not indexed: its stable `code`, exit 2, nothing changed. */
export function emitNotActive(command: string, refusal: CatalogNotActiveError, options: CatalogCommandOptions): number {
  return emit(command, { refusal: { code: refusal.code, message: refusal.message } }, [refusal.message], options, EXIT_REFUSED);
}

/** `llmwiki catalog sync`. */
export async function catalogSyncCommand(options: CatalogCommandOptions = {}): Promise<number> {
  try {
    const report = await catalogSync(process.cwd());
    return emit("catalog sync", { ...report }, [`Reconciled: ${report.reprojected} projected, ${report.removed} removed, ${report.uncatalogued} uncatalogued`], options);
  } catch (error) {
    if (error instanceof CatalogNotActiveError) return emitNotActive("catalog sync", error, options);
    throw error;
  }
}

/** One line of the verified stores' disk inventory; an incomplete inventory says so. */
function storageLine(storage: IndexedStorageV1): string {
  const line = `Storage: ${storage.segments} segments, ${storage.referencedBytes} bytes referenced; ${storage.retainedLeaves} retained leaves, ${storage.retainedBytes} bytes (retained until an explicit "llmwiki catalog gc")`;
  if (storage.complete) return line;
  return `${line}; INCOMPLETE: ${storage.unmeasuredStores.count} store(s) unmeasured${storage.unmeasuredStores.count > 0 ? ` (${storage.unmeasuredStores.sample.join(", ")})` : ""}, ${storage.unmeasuredLeaves} retained leaf/leaves unmeasured`;
}

/** `llmwiki catalog verify`: full read-only verification of every indexed store. */
export async function catalogVerifyCommand(options: CatalogCommandOptions = {}): Promise<number> {
  try {
    const report = await catalogVerify(process.cwd());
    const lines = [
      `Verified ${report.storesChecked} stores: ${report.storesFailed} failed`, storageLine(report.storage),
      ...report.stores.filter((store) => !store.ok).map((store) => `${store.store}: ${store.problems.join("; ")}`),
    ];
    return emit("catalog verify", { ...report }, lines, options, report.ok ? EXIT_OK : EXIT_BLOCKED);
  } catch (error) {
    if (error instanceof CatalogNotActiveError) return emitNotActive("catalog verify", error, options);
    throw error;
  }
}

/** Human lines of a custom profile's block: its entity pages, its problems, and both continuations. */
function profileLines(block: ListPagesProfileBlock | undefined): string[] {
  if (block === undefined) return [];
  return [
    `Entity pages: ${block.entityPages.length} of ${block.total}`, ...block.entityPages.map((page) => `${page.id}: ${page.title ?? page.slug}`),
    ...(block.cursor ? [`Next entity pages: --profile-cursor ${block.cursor}`] : []),
    ...(block.problemTotal === undefined ? [] : [`Problems: ${block.problems?.length ?? 0} of ${block.problemTotal}`]),
    ...(block.problems ?? []).map((problem) => `Problem (${problem.kind}) ${problem.path ?? problem.entityType}: ${problem.message}`),
    ...(block.problemCursor ? [`Next problems: --problem-cursor ${block.problemCursor}`] : []),
  ];
}

/** `llmwiki catalog pages [--cursor c] [--limit n] [--profile-cursor c] [--problem-cursor c] [--include-body]`. */
export async function catalogPagesCommand(options: CatalogCommandOptions = {}): Promise<number> {
  try {
    const result = await routedListPages(process.cwd(), {
      cursor: options.cursor, limit: parseLimit(options.limit), includeArchived: options.includeArchived, includeOrphaned: options.includeOrphaned,
      profileCursor: options.profileCursor, problemCursor: options.problemCursor, includeBody: options.includeBody,
    });
    const lines = [
      ...noteLines(result.catalog), ...result.pages.map((page) => `${page.pageDirectory}/${page.slug}: ${page.title}`),
      ...(result.cursor ? [`Next: --cursor ${result.cursor}`] : []), ...profileLines(result.profile),
    ];
    return emit("catalog pages", { ...result }, lines, options);
  } catch (error) {
    if (error instanceof CatalogTypedError) return emit("catalog pages", { refusal: { code: error.code, message: error.message } }, [error.message], options, EXIT_REFUSED);
    throw error;
  }
}

/** `llmwiki catalog sources [--cursor c] [--limit n]`. */
export async function catalogSourcesCommand(options: CatalogCommandOptions = {}): Promise<number> {
  const result = await routedListSources(process.cwd(), { cursor: options.cursor, limit: parseLimit(options.limit) });
  const lines = [...noteLines(result.catalog), ...result.sources.map((source) => `${source.id}: ${source.title}`), ...(result.cursor ? [`Next: --cursor ${result.cursor}`] : [])];
  return emit("catalog sources", { ...result }, lines, options);
}
