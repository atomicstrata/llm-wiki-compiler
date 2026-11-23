/**
 * @file src/history/history-verify.ts
 * @description Explicit read-only FULL VERIFICATION of the segmented relation
 * log and workspace operation catalogs (the event log's lives in
 * `./events-read.ts`).
 *
 * A full verification streams every record once with bounded memory (one block
 * per run, one record at a time), checks each record's own validation, the
 * index sequence, the point indexes that must exist for it (exact point
 * joins, their repeated segment reads served by a bounded verification-only
 * cache), the fresh segment digests and the backup's bytes, and keeps a bounded problem sample with the
 * full count. It reports health for THIS RESPONSE only and writes nothing.
 */

import { checkedRelationRecord } from "../relations/record-check.js";
import { normalizeCatalogRecord, type CatalogRecord } from "../operation-bundles/catalog-record.js";
import { MAX_CATALOG_FILE_BYTES } from "../operation-bundles/constants.js";
import { MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import type { SegmentStore } from "../segments/store.js";
import { withVerificationReads } from "../segments/verification-cache.js";
import { storageOf, verifyStore } from "../segments/verify.js";
import { indexKey, keyIndex, legacyBytesUnchanged, legacyDriftMessage, ProblemSample, type LegacySnapshot } from "./contracts.js";
import type { HistoryVerification } from "./events-read.js";
import {
  CATALOG_RECORD_PREFIX, catalogRecordAt, catalogRecordByMutation, logicalRootKey, openOperationCatalog, readyOperationCatalogMeta,
} from "./operation-catalog.js";
import { latestRelationById, openRelationLog, readyRelationLogMeta, RELATION_PREFIX } from "./relations-log.js";

/** Stream `prefix` records, checking index order and per-record `check`, into `problems`; returns the count. */
async function streamRecords(store: SegmentStore, prefix: string, problems: ProblemSample, check: (value: unknown, index: number) => Promise<void>): Promise<number> {
  let count = 0;
  for await (const row of store.scan({ prefix })) {
    if (keyIndex(prefix, row.k) !== count) problems.note(`record index gap at ${row.k}`);
    try { await check(row.v, count); } catch (error) { problems.note(error instanceof Error ? error.message : String(error)); }
    count += 1;
  }
  return count;
}

/** The common tail of a verification: count, segment digests, backup bytes. */
async function finish(store: SegmentStore, root: string, count: number, expected: number, legacy: LegacySnapshot, cap: number, problems: ProblemSample): Promise<HistoryVerification> {
  if (count !== expected) problems.note(`the manifest counts ${expected} records, ${count} are stored`);
  const storage = storageOf(await verifyStore(store));
  if (!(await legacyBytesUnchanged(root, legacy, cap))) problems.note(legacyDriftMessage(legacy));
  return { ok: problems.count === 0, records: count, problemCount: problems.count, problems: problems.sample, storage };
}

/**
 * Check one relation record's indexes. Every record's id must resolve, through
 * the strict latest-id accessor, to a record of the same id at an index no
 * earlier than its own and within the log; so a newer occurrence can never be
 * hidden (its own check would find the latest pointer behind it). The latest
 * version must have its content index row, and a bound record its binding row.
 */
async function checkRelation(store: SegmentStore, value: unknown, index: number, count: number): Promise<void> {
  const record = checkedRelationRecord(value);
  const latest = await latestPointer(store, record.ref.id, index, count);
  if ((await latestRelationById(store, record.ref.id))?.ref.id !== record.ref.id) throw new Error(`relation ${record.ref.id} latest-id index resolves elsewhere`);
  if (latest === index && (await store.get(`h${record.ref.contentHash}:${record.ref.id}`)) === undefined) throw new Error(`relation ${record.ref.id} is missing its content index`);
  const binding = record.operationBinding;
  if (binding !== undefined && (await store.get(indexKey(`b${binding.mutationId}:`, index))) === undefined) throw new Error(`relation ${record.ref.id} is missing its binding index`);
}

/** The latest-id pointer of relation `id`, which must address an index at or after `index` and before `count`. */
async function latestPointer(store: SegmentStore, id: string, index: number, count: number): Promise<number> {
  const latest = ((await store.get(`i${id}`)) as { latest?: unknown } | undefined)?.latest;
  if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < index || latest >= count) throw new Error(`relation ${id} has no valid latest-id index`);
  return latest;
}

/** Full verification of the relation log: checksums, latest-id, content and binding indexes, digests, backup. Extra index rows not addressed by any record are not enumerated. */
export async function verifyRelationHistory(root: string): Promise<HistoryVerification> {
  return withVerificationReads(await openRelationLog(root), async (store) => {
    const meta = readyRelationLogMeta(store);
    const problems = new ProblemSample();
    const count = await streamRecords(store, RELATION_PREFIX, problems, (value, index) => checkRelation(store, value, index, meta.count));
    return finish(store, root, count, meta.count, meta.legacy, MAX_RELATION_STORE_BYTES, problems);
  });
}

/** The index a lineage row stores, or undefined. */
async function lineageIndex(store: SegmentStore, key: string): Promise<unknown> {
  return ((await store.get(key)) as { index?: unknown } | undefined)?.index;
}

/**
 * Check one catalog record's lineage through point lookups: its mutation and
 * physical indexes address it; a root owns its logical-root index; a
 * successor owns its predecessor's successor index, and the predecessor is
 * EARLIER and of the same logical identity. The incumbent replay's invariants,
 * without a whole-graph map.
 */
async function checkCatalogRecord(store: SegmentStore, value: unknown, index: number): Promise<void> {
  const record = normalizeCatalogRecord(value as CatalogRecord).record;
  if ((await catalogRecordByMutation(store, record.mutationId))?.physicalRecordId !== record.physicalRecordId) throw new Error(`catalog record ${record.physicalRecordId} is missing its mutation index`);
  if ((await lineageIndex(store, `p${record.physicalRecordId}`)) !== index) throw new Error(`catalog record ${record.physicalRecordId} is missing its physical index`);
  if (record.supersedesRecordId === undefined) {
    if ((await lineageIndex(store, logicalRootKey(record.logicalRecordId))) !== index) throw new Error(`catalog record ${record.physicalRecordId} does not own its logical root`);
    return;
  }
  await checkPredecessor(store, record, record.supersedesRecordId, index);
}

/** A successor owns its predecessor's successor index, and the predecessor is EARLIER and of the same logical identity. */
async function checkPredecessor(store: SegmentStore, record: CatalogRecord, supersedes: string, index: number): Promise<void> {
  if ((await lineageIndex(store, `s${supersedes}`)) !== index) throw new Error(`catalog record ${record.physicalRecordId} does not own its predecessor's successor index`);
  const predecessorAt = await lineageIndex(store, `p${supersedes}`);
  if (typeof predecessorAt !== "number" || !(predecessorAt < index)) throw new Error(`catalog record ${record.physicalRecordId} has no earlier predecessor`);
  const predecessor = await catalogRecordAt(store, predecessorAt);
  if (predecessor.physicalRecordId !== supersedes || predecessor.logicalRecordId !== record.logicalRecordId) throw new Error(`catalog record ${record.physicalRecordId} supersedes across identities`);
}

/** Full verification of one workspace catalog: canonical records, every lineage invariant, digests, backup. */
export async function verifyOperationCatalog(root: string, workspaceId: string): Promise<HistoryVerification> {
  return withVerificationReads(await openOperationCatalog(root, workspaceId), async (store) => {
    const meta = readyOperationCatalogMeta(store, root, workspaceId);
    const problems = new ProblemSample();
    const count = await streamRecords(store, CATALOG_RECORD_PREFIX, problems, (value, index) => checkCatalogRecord(store, value, index));
    return finish(store, root, count, meta.count, meta.legacy, MAX_CATALOG_FILE_BYTES, problems);
  });
}
