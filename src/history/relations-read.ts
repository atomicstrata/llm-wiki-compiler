/**
 * @file src/history/relations-read.ts
 * @description Reads of the segmented relation log, and the port the
 * incumbent relation bodies dispatch to on a `local-indexed` project.
 *
 * `readAllRelationRecords` is the CAPPED whole-history compatibility
 * materializer (cold O(history), capped at the incumbent 64 MiB store cap,
 * refusing beyond it); the incumbent `readRelations*` callers keep it. The
 * create, update and operation writes go through point lookups instead.
 */

import type { EventBoundWriteSources, EventWriteSources } from "../events/store.js";
import type { ProfilePack } from "../profile/types.js";
import type { RelationOperationApply } from "../relations/operation-apply.js";
import { checkedRelationRecord, type BoundRelationRecord, type ReadRelationRecordsResult } from "../relations/record-check.js";
import type { AppendRelationInput, UpdateRelationPatch } from "../relations/relation-build.js";
import type { RelationRef } from "../relations/types.js";
import { indexedActive } from "../indexed/routing.js";
import { MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { HistoryMaterializationTooLargeError, legacyDriftMessage, legacyUnchanged } from "./contracts.js";
import { openRelationLog, readyRelationLogMeta, RELATION_PREFIX } from "./relations-log.js";
import { appendSegmentedRelation, appendSegmentedRelationForOperation, updateSegmentedRelation } from "./relations-write.js";

/** Every record in append order (capped; O(history)), plus a legacy-drift problem when the backup changed. */
async function readAllRelationRecords(root: string): Promise<ReadRelationRecordsResult> {
  const store = await openRelationLog(root);
  const meta = readyRelationLogMeta(store);
  const records: BoundRelationRecord[] = [];
  let bytes = 0;
  for await (const row of store.scan({ prefix: RELATION_PREFIX })) {
    bytes += Buffer.byteLength(JSON.stringify(row.v), "utf8") + 1;
    if (bytes >= MAX_RELATION_STORE_BYTES) throw new HistoryMaterializationTooLargeError("relation", MAX_RELATION_STORE_BYTES);
    records.push(checkedRelationRecord(row.v));
  }
  const problems = (await legacyUnchanged(root, meta.legacy, store.counters)) ? [] : [legacyDriftMessage(meta.legacy)];
  return { records, problems };
}

/** What the incumbent relation bodies ask of the segmented log when the project is `local-indexed`. */
export interface SegmentedRelationLog {
  readRecords(): Promise<ReadRelationRecordsResult>;
  append(events: EventWriteSources, profile: ProfilePack, input: AppendRelationInput, decision?: string): Promise<RelationRef>;
  update(events: EventWriteSources, profile: ProfilePack, id: RelationRef["id"], patch: UpdateRelationPatch): Promise<RelationRef>;
  appendForOperation(
    events: EventBoundWriteSources, profile: ProfilePack, input: AppendRelationInput, binding: OperationBinding, promisedId?: RelationRef["id"],
  ): Promise<RelationOperationApply>;
}

/** The segmented relation log of `root` when it is the active authority, else `null`. */
export async function segmentedRelationLogFor(root: string): Promise<SegmentedRelationLog | null> {
  if (!(await indexedActive(root))) return null;
  return {
    readRecords: () => readAllRelationRecords(root),
    append: (events, profile, input, decision) => appendSegmentedRelation(root, events, profile, input, decision),
    update: (events, profile, id, patch) => updateSegmentedRelation(root, events, profile, id, patch),
    appendForOperation: (events, profile, input, binding, promisedId) => appendSegmentedRelationForOperation(root, events, profile, input, binding, promisedId),
  };
}
