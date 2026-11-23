/**
 * @file src/history/relations-log.ts
 * @description The SEGMENTED RELATION LOG of a `local-indexed` project: the
 * incumbent `RelationRecord`s (ids, content hashes, checksums, operation
 * bindings) as rows `r<index>` in append order, plus point indexes written in
 * the SAME commit:
 *
 * - `i<id>` → the index of the id's LATEST record (an update appends a new
 *   record under the same id, as the incumbent log does);
 * - `h<contentHash>:<id>` → present only for each id's latest record, so the
 *   live-content dedupe is one prefix lookup;
 * - `b<mutationId>:<index>` → the records bound to an operation mutation.
 *
 * Every lookup reads a bounded number of rows; the whole-history read is the
 * capped compatibility materializer in `./relations-read.ts`. Writes run
 * under the caller's project lock and fail closed when the imported legacy
 * file changed afterwards. Compaction is refused: the segmented log has no
 * single-file cap to relieve, and rewriting authoritative history is out of
 * scope.
 */

import {
  RELATION_STORE_BASE_WRITE_VERSION, RELATION_STORE_OPERATION_VERSION, RelationStoreCorruptError, type RelationRef,
} from "../relations/types.js";
import { RELATIONS_FILE } from "../utils/constants.js";
import { checkedRelationRecord, type BoundRelationRecord } from "../relations/record-check.js";
import { recordChecksum } from "../relations/store-record.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { hasExactKeys, indexKey, isCount, isLegacySnapshot, keyIndex, legacyDriftMessage, legacyUnchanged, type LegacySnapshot } from "./contracts.js";

/** The relation log's segment store. */
const RELATIONS_STORE = "relations";
/** Record key prefix. */
export const RELATION_PREFIX = "r";

/** The relation log's manifest facts. */
export interface RelationLogMeta {
  readonly schema: 1;
  readonly phase: "importing" | "ready";
  readonly count: number;
  readonly headerVersion: number;
  readonly legacy: LegacySnapshot;
}

/** Open the relation log of `root`. */
export function openRelationLog(root: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, RELATIONS_STORE), counters === undefined ? {} : { counters });
}

/** The validated facts of an opened relation log; anything malformed is corruption. */
export function relationLogMetaOf(store: SegmentStore): RelationLogMeta {
  const meta = store.meta;
  const valid = store.exists && hasExactKeys(meta, ["schema", "phase", "count", "headerVersion", "legacy"]) && meta.schema === 1
    && (meta.phase === "importing" || meta.phase === "ready") && isCount(meta.count)
    && (meta.headerVersion === RELATION_STORE_BASE_WRITE_VERSION || meta.headerVersion === RELATION_STORE_OPERATION_VERSION)
    && isLegacySnapshot(meta.legacy, RELATIONS_FILE);
  if (!valid) throw new RelationStoreCorruptError("the segmented relation log manifest is missing or malformed");
  return meta as unknown as RelationLogMeta;
}

/** The facts of a log active readers may use: well formed and fully imported. */
export function readyRelationLogMeta(store: SegmentStore): RelationLogMeta {
  const meta = relationLogMetaOf(store);
  if (meta.phase !== "ready") throw new RelationStoreCorruptError("the segmented relation log has not finished importing");
  return meta;
}

/** The ready log of `root` for a write; refuses an unfinished import or a changed legacy backup. Caller holds the lock. */
export async function relationLogForWrite(root: string): Promise<{ store: SegmentStore; meta: RelationLogMeta }> {
  const store = await openRelationLog(root);
  const meta = readyRelationLogMeta(store);
  if (!(await legacyUnchanged(root, meta.legacy, store.counters))) throw new RelationStoreCorruptError(legacyDriftMessage(meta.legacy));
  return { store, meta };
}

/** The record at `index`, validated. */
async function recordAt(store: SegmentStore, index: number): Promise<BoundRelationRecord> {
  return checkedRelationRecord(await store.get(indexKey(RELATION_PREFIX, index)));
}

/** The latest record of `id`, or undefined: two point reads. */
export async function latestRelationById(store: SegmentStore, id: string): Promise<BoundRelationRecord | undefined> {
  const latest = (await store.get(`i${id}`)) as { latest?: unknown } | undefined;
  if (latest === undefined) return undefined;
  if (!Number.isSafeInteger(latest.latest)) throw new RelationStoreCorruptError(`relation id index for ${id} is malformed`);
  const record = await recordAt(store, latest.latest as number);
  if (record.ref.id !== id) throw new RelationStoreCorruptError(`relation id index for ${id} points at ${record.ref.id}`);
  return record;
}

/** The live relation whose latest content hash is `contentHash`, or undefined: one prefix lookup. */
export async function liveRelationByContent(store: SegmentStore, contentHash: string): Promise<BoundRelationRecord | undefined> {
  for await (const row of store.scan({ prefix: `h${contentHash}:` })) {
    const record = await latestRelationById(store, row.k.slice(contentHash.length + 2));
    if (record?.ref.contentHash === contentHash) return record;
  }
  return undefined;
}

/** The records bound to `mutationId` from the binding index, cross-checked, stopping at a proved duplicate (two). */
export async function relationsByMutation(store: SegmentStore, mutationId: string): Promise<BoundRelationRecord[]> {
  const prefix = `b${mutationId}:`;
  const records: BoundRelationRecord[] = [];
  for await (const row of store.scan({ prefix })) {
    const record = await recordAt(store, keyIndex(prefix, row.k));
    if (record.operationBinding?.mutationId !== mutationId) throw new RelationStoreCorruptError(`relation binding index disagrees with relation ${record.ref.id}`);
    records.push(record);
    if (records.length >= 2) break;
  }
  return records;
}

/** The rows that append `ref` (bound when `binding` is given) at `index`, superseding `previous`. The ref was capped when built. */
export function relationRows(index: number, ref: RelationRef, binding: OperationBinding | undefined, previous: RelationRef | undefined): SegmentRow[] {
  const record = { ...ref, ...(binding === undefined ? {} : { operationBinding: binding }), checksum: recordChecksum(ref, binding) };
  const rows: SegmentRow[] = [
    { k: indexKey(RELATION_PREFIX, index), v: record },
    { k: `i${ref.id}`, v: { latest: index } },
    { k: `h${ref.contentHash}:${ref.id}`, v: {} },
  ];
  if (previous !== undefined && previous.contentHash !== ref.contentHash) rows.push({ k: `h${previous.contentHash}:${previous.id}`, d: 1 });
  if (binding !== undefined) rows.push({ k: indexKey(`b${binding.mutationId}:`, index), v: {} });
  return sortedByKey(rows);
}

/** Append `ref` to a ready log in one conditional commit. */
export async function commitRelation(
  store: SegmentStore, meta: RelationLogMeta, ref: RelationRef, binding?: OperationBinding, previous?: RelationRef,
): Promise<void> {
  const headerVersion = binding === undefined ? meta.headerVersion : Math.max(meta.headerVersion, RELATION_STORE_OPERATION_VERSION);
  await store.commit({ rows: relationRows(meta.count, ref, binding, previous), meta: { ...meta, count: meta.count + 1, headerVersion } });
}
