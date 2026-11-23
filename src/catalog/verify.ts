/**
 * @file src/catalog/verify.ts
 * @description Full, read-only verification of the catalog store itself:
 * explicit O(rows) work that streams every row once with bounded memory.
 *
 * It checks the segment digests, every row's strict shape (entity rows too,
 * with the typed catalog's totals), that each source
 * row has its identity row, that every identity row names a source row
 * carrying that identity, and that the manifest's counts equal the rows
 * actually stored. It does NOT compare rows with the files (that is a
 * reconciliation, `catalog sync`); freshness against the files is reported
 * by every listing.
 */

import { ProblemSample } from "../history/contracts.js";
import type { HistoryVerification } from "../history/events-read.js";
import type { SegmentStore } from "../segments/store.js";
import { withVerificationReads } from "../segments/verification-cache.js";
import { storageOf, verifyStore } from "../segments/verify.js";
import { identityKey } from "./contracts.js";
import { catalogMetaOf } from "./meta.js";
import { asEntityDirRow, asEntityFileRow, type EntityFileRowV1, isEntityDirKey, parseEntityKey } from "./entity-rows.js";
import { asPageRow, asSourceRow, stampOfRow } from "./rows.js";

/** Entity totals counted by a verification. */
interface EntityCounted { pages: number; problems: number; rows: number }

/** Entity rows exist exactly when the manifest declares a typed catalog, and its totals match them. */
function checkTypedTotals(meta: ReturnType<typeof catalogMetaOf>, entities: EntityCounted, problems: ProblemSample): void {
  if (meta.typed === undefined) { if (entities.rows > 0) problems.note(`${entities.rows} entity rows exist but the catalog declares no typed entity catalog`); return; }
  if (meta.typed.pages !== entities.pages || meta.typed.problems !== entities.problems) {
    problems.note(`the manifest counts ${meta.typed.pages}/${meta.typed.problems} entity pages/problems, ${entities.pages}/${entities.problems} are stored`);
  }
}

/**
 * Check one entity row's strict shape and count it. Every row's type (file
 * or directory row, whatever its page) must be one the typed catalog
 * declares, and a stored page view must name that type's declared directory.
 */
function checkEntityRow(key: string, value: unknown, counted: EntityCounted, directories: Readonly<Record<string, string>> | undefined): void {
  counted.rows += 1;
  const type = isEntityDirKey(key) ? key.slice(2, -1) : parseEntityKey(key).type;
  if (directories !== undefined && !Object.hasOwn(directories, type)) throw new Error(`entity row ${key.slice(0, 80)} is of a type its typed catalog does not declare`);
  if (isEntityDirKey(key)) { counted.problems += asEntityDirRow(value, key).problems.length; return; }
  checkEntityFileRow(key, asEntityFileRow(value, key), type, counted, directories);
}

/** Check one entity file row's page directory against the declared one, and count it. */
function checkEntityFileRow(key: string, row: EntityFileRowV1, type: string, counted: EntityCounted, directories: Readonly<Record<string, string>> | undefined): void {
  if (typeof row.page === "object" && row.page !== null && directories?.[type] !== row.page.directory) throw new Error(`entity row ${key.slice(0, 80)} names a directory its typed catalog does not declare for ${type}`);
  if (row.page !== null) counted.pages += 1;
  counted.problems += row.problems.length;
}

/** Check one row; returns the count bucket it falls in, if any. */
/** Check a source row and that its identity row exists. */
async function checkSourceRow(store: SegmentStore, key: string, value: unknown): Promise<"sources"> {
  const row = asSourceRow(value, key);
  if ((await store.get(identityKey(row.source, key.slice(2)))) === undefined) throw new Error(`source ${key.slice(2)} is missing its identity row`);
  return "sources";
}

/** Check an identity row names a matching source. */
async function checkIdentityRow(store: SegmentStore, key: string): Promise<null> {
  const id = key.slice(key.indexOf(":", 2) + 1);
  const source = await store.get(`s:${id}`);
  if (source === undefined || identityKey(asSourceRow(source, `s:${id}`).source, id) !== key) throw new Error(`identity row ${key.slice(0, 80)} names no matching source`);
  return null;
}

/** Check one row; returns the count bucket it falls in, if any. */
async function checkRow(store: SegmentStore, key: string, value: unknown, entities: EntityCounted, directories?: Readonly<Record<string, string>>): Promise<"concepts" | "queries" | "sources" | null> {
  if (key.startsWith("e:")) { checkEntityRow(key, value, entities, directories); return null; }
  if (key.startsWith("d:")) { stampOfRow(key, value); return null; }
  if (key.startsWith("p:")) { asPageRow(value, key); return key.startsWith("p:concepts/") ? "concepts" : "queries"; }
  if (key.startsWith("s:")) return checkSourceRow(store, key, value);
  if (key.startsWith("i:")) return checkIdentityRow(store, key);
  throw new Error(`unexpected catalog key ${key.slice(0, 80)}`);
}

/**
 * Verify the catalog store completely; health for this response only. A
 * catalog that does not exist (a lost or never-written manifest) or whose
 * first reconciliation never finished is a failure, never an empty green.
 */
export async function verifyCatalogStore(opened: SegmentStore): Promise<HistoryVerification> {
  if (!opened.exists) throw new Error("the catalog is missing: its manifest is absent (lost or never built); restore it from a backup or rebuild it with `llmwiki catalog sync`");
  const meta = catalogMetaOf(opened);
  if (meta.phase === "building") throw new Error("the catalog's first reconciliation never finished; run `llmwiki catalog sync`");
  return withVerificationReads(opened, (store) => verifyCatalogRows(store, meta));
}

/** Stream and check every catalog row of `store` against `meta`'s counts. */
async function verifyCatalogRows(store: SegmentStore, meta: ReturnType<typeof catalogMetaOf>): Promise<HistoryVerification> {
  const problems = new ProblemSample();
  const counted = { concepts: 0, queries: 0, sources: 0 };
  const entities: EntityCounted = { pages: 0, problems: 0, rows: 0 };
  let rows = 0;
  for await (const row of store.scan()) {
    rows += 1;
    try {
      const bucket = await checkRow(store, row.k, row.v, entities, meta.typed?.directories);
      if (bucket !== null) counted[bucket] += 1;
    } catch (error) { problems.note(error instanceof Error ? error.message : String(error)); }
  }
  const { concepts, queries, sources } = meta.counts;
  if (counted.concepts !== concepts || counted.queries !== queries || counted.sources !== sources) {
    problems.note(`the manifest counts ${concepts}/${queries}/${sources} concepts/queries/sources, ${counted.concepts}/${counted.queries}/${counted.sources} are stored`);
  }
  checkTypedTotals(meta, entities, problems);
  const storage = storageOf(await verifyStore(store));
  return { ok: problems.count === 0, records: rows, problemCount: problems.count, problems: problems.sample, storage };
}
