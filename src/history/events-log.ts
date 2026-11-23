/**
 * @file src/history/events-log.ts
 * @description The SEGMENTED EVENT LOG of a `local-indexed` project and its
 * append path. A NEW FORMAT CONTRACT, documented here rather than inherited
 * from the single-file log's proof:
 *
 * - Records are the incumbent `EventRecord`s (same ids, `prevHash` chain,
 *   checksum, operation binding), immutable rows `e<index>`; a bound record
 *   also writes `m<mutationId>:<index>` in the same commit.
 * - The COMMIT POINT is the store's conditional manifest publication under
 *   the project lock (the single-file log committed at its head seal and
 *   rolled an unsealed record back; here a published record is committed and
 *   never rolled back). The head anchor `.llmwiki/events.head` is resealed
 *   AFTER the commit, strictly durably, as a tamper tripwire. An anchor one
 *   record behind is exactly that commit-to-reseal window and is resealed by
 *   the next append; anything else refuses. A reseal that fails after the
 *   commit reports `indexed_store_outcome_unknown` (the event IS committed).
 * - An APPEND checks only the committed tail: the manifest, the last record's
 *   checksum, that its digest is the recorded head, that its `prevHash` is its
 *   predecessor's digest (or genesis), the anchor, and the backup's stamp. It
 *   does NOT re-verify untouched history: that is the separate, read-only
 *   `verifyEventHistory`; an accessed corrupt record always fails closed.
 */

import path from "node:path";
import { assertRecordWithinCap, buildEventRecord, type AppendEventInput } from "../events/event-build.js";
import { eventPrevHash } from "../events/event-digest.js";
import { diskHeadAnchorSources, readHeadAnchorFrom } from "../events/head-anchor.js";
import { checkedEventRecord } from "../events/record-check.js";
import { serializeEventRecord } from "../events/store-record.js";
import {
  EVENT_STORE_BASE_WRITE_VERSION, EVENT_STORE_OPERATION_VERSION, EventStoreChainError, EventStoreCorruptError, GENESIS_PREV_HASH,
  type EventRecord,
} from "../events/types.js";
import { indexedActive } from "../indexed/routing.js";
import { IndexedStoreError } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../utils/constants.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { hasExactKeys, indexKey, isCount, isLegacySnapshot, legacyDriftMessage, legacyUnchanged, type LegacySnapshot } from "./contracts.js";

/** The event log's segment store. */
const EVENTS_STORE = "events";
/** Record key prefix. */
export const EVENT_PREFIX = "e";

/** The event log's manifest facts. */
export interface EventLogMeta {
  readonly schema: 1;
  readonly phase: "importing" | "ready";
  readonly count: number;
  /** `eventPrevHash` of the last record, or null for an empty log. */
  readonly headDigest: string | null;
  readonly headerVersion: number;
  readonly legacy: LegacySnapshot;
}

/** The binding-index key of record `index` bound to `mutationId`. */
export function bindingKey(mutationId: string, index: number): string {
  return indexKey(`m${mutationId}:`, index);
}

/** Open the event log of `root`. */
export function openEventLog(root: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, EVENTS_STORE), counters === undefined ? {} : { counters });
}

/** Whether `value` is a head digest of the right domain. */
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The validated (closed, coherent) facts of an opened event log; anything else is corruption. */
export function eventLogMetaOf(store: SegmentStore): EventLogMeta {
  const meta = store.meta;
  const valid = store.exists && hasExactKeys(meta, ["schema", "phase", "count", "headDigest", "headerVersion", "legacy"])
    && meta.schema === 1 && (meta.phase === "importing" || meta.phase === "ready") && isCount(meta.count)
    && (meta.headDigest === null ? meta.count === 0 : isDigest(meta.headDigest) && meta.count > 0)
    && (meta.headerVersion === EVENT_STORE_BASE_WRITE_VERSION || meta.headerVersion === EVENT_STORE_OPERATION_VERSION)
    && isLegacySnapshot(meta.legacy, EVENTS_FILE);
  if (!valid) throw new EventStoreCorruptError("the segmented event log manifest is missing or malformed");
  return meta as unknown as EventLogMeta;
}

/** The facts of a log active readers may use: well formed and fully imported. */
export function readyEventLogMeta(store: SegmentStore): EventLogMeta {
  const meta = eventLogMetaOf(store);
  if (meta.phase !== "ready") throw new EventStoreCorruptError("the segmented event log has not finished importing");
  return meta;
}

/** The committed tail, checked against the recorded head and its predecessor's digest (at most two point reads). */
async function committedTail(store: SegmentStore, meta: EventLogMeta): Promise<EventRecord | null> {
  if (meta.count === 0) return null;
  const last = checkedEventRecord(await store.get(indexKey(EVENT_PREFIX, meta.count - 1)));
  if (eventPrevHash(last) !== meta.headDigest) throw new EventStoreCorruptError("the last committed event does not match the recorded head");
  const expected = meta.count === 1 ? GENESIS_PREV_HASH : eventPrevHash(checkedEventRecord(await store.get(indexKey(EVENT_PREFIX, meta.count - 2))));
  if (last.prevHash !== expected) throw new EventStoreChainError("the last committed event does not chain from its sealed predecessor");
  return last;
}

/** Reseal the head anchor to `digest`, strictly durably and privately. */
function sealHead(root: string, digest: string): Promise<void> {
  return atomicWrite(path.join(root, EVENTS_HEAD_FILE), digest, { confineRoot: root, durable: true, strictDurability: true, mode: 0o600 });
}

/** Compare the anchor with the committed head; reseal the one-behind window, refuse anything else. */
async function checkAnchor(root: string, meta: EventLogMeta, tail: EventRecord | null): Promise<void> {
  const anchor = await readHeadAnchorFrom(diskHeadAnchorSources(root));
  if (anchor === meta.headDigest) return;
  const oneBehind = tail !== null && anchor === (meta.count === 1 ? null : tail.prevHash);
  if (!oneBehind) throw new EventStoreChainError("head anchor does not match the committed segmented event log");
  await sealHead(root, meta.headDigest!);
}

/** The bounded write precondition: manifest, backup stamp, committed tail, anchor. Caller holds the lock. */
export async function verifyEventLogForAppend(root: string): Promise<{ store: SegmentStore; meta: EventLogMeta }> {
  const store = await openEventLog(root);
  const meta = readyEventLogMeta(store);
  if (!(await legacyUnchanged(root, meta.legacy, store.counters))) throw new EventStoreCorruptError(legacyDriftMessage(meta.legacy));
  await checkAnchor(root, meta, await committedTail(store, meta));
  return { store, meta };
}

/** Build the next record for `input` on `meta`, refusing an oversized one before any write. */
function nextRecord(meta: EventLogMeta, input: AppendEventInput, binding?: OperationBinding): EventRecord {
  const record = buildEventRecord(input, meta.headDigest ?? GENESIS_PREV_HASH, binding);
  const { checksum: _checksum, ...unchecked } = record;
  assertRecordWithinCap(serializeEventRecord(unchecked));
  return record;
}

/** Reseal after a commit; a failure here leaves the event committed with its outcome to reconcile. */
async function resealAfterCommit(root: string, digest: string): Promise<void> {
  try {
    await sealHead(root, digest);
  } catch (error) {
    throw new IndexedStoreError("indexed_store_outcome_unknown", `the event is committed but the head anchor reseal failed (${error instanceof Error ? error.message : String(error)}); the next append reseals it`);
  }
}

/** Append one event (bound when `binding` is given). The caller holds the project lock. */
export async function appendSegmentedEvent(root: string, input: AppendEventInput, binding?: OperationBinding): Promise<EventRecord> {
  const { store, meta } = await verifyEventLogForAppend(root);
  const record = nextRecord(meta, input, binding);
  const rows: Array<{ k: string; v: unknown }> = [{ k: indexKey(EVENT_PREFIX, meta.count), v: record }];
  if (binding !== undefined) rows.push({ k: bindingKey(binding.mutationId, meta.count), v: { type: record.type } });
  const digest = eventPrevHash(record);
  const headerVersion = binding === undefined ? meta.headerVersion : EVENT_STORE_OPERATION_VERSION;
  await store.commit({ rows, meta: { ...meta, count: meta.count + 1, headDigest: digest, headerVersion } });
  await resealAfterCommit(root, digest);
  return record;
}

/** The append's checks and size cap, writing nothing (beyond resealing a one-behind anchor). */
export async function preflightSegmentedEvent(root: string, input: AppendEventInput): Promise<void> {
  const { meta } = await verifyEventLogForAppend(root);
  nextRecord(meta, input);
}
