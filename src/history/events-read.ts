/**
 * @file src/history/events-read.ts
 * @description Reads of the segmented event log: BOUNDED narrow reads (a page
 * by index, the events bound to one operation mutation), the explicit
 * read-only FULL verification, and the capped whole-history COMPATIBILITY
 * materializer the incumbent `readEvents` callers keep.
 *
 * The materializer is cold O(history) work, capped at the incumbent 64 MiB
 * store cap so no caller can be handed more than the single-file log could
 * ever have held; beyond it, it refuses with
 * `history_materialization_too_large`. No bounded path calls it.
 *
 * Full verification reports health for THIS RESPONSE only, with a bounded
 * problem sample and full count, and writes nothing; a later commit makes it
 * stale. Integrity of untouched history is otherwise UNKNOWN: appends check
 * only the committed tail.
 */

import { eventPrevHash } from "../events/event-digest.js";
import { diskHeadAnchorSources, readHeadAnchorFrom } from "../events/head-anchor.js";
import { checkedEventRecord, verifyEventChain } from "../events/record-check.js";
import { GENESIS_PREV_HASH, type EventRecord } from "../events/types.js";
import { MAX_EVENT_STORE_BYTES } from "../utils/constants.js";
import type { SegmentStore } from "../segments/store.js";
import { withVerificationReads } from "../segments/verification-cache.js";
import { storageOf, verifyStore, type StorageInventoryV1 } from "../segments/verify.js";
import {
  HistoryMaterializationTooLargeError, indexKey, keyIndex, legacyBytesUnchanged, legacyDriftMessage, legacyUnchanged, pageSize, ProblemSample,
} from "./contracts.js";
import { bindingKey, EVENT_PREFIX, openEventLog, readyEventLogMeta } from "./events-log.js";

/** The most events one page returns. */
const MAX_EVENT_PAGE = 1000;
/** Bound lookups stop after this many matches: two are enough to prove a duplicate. */
const DUPLICATE_PROOF = 2;

/** Every event, in order, plus the incumbent reader's problems (chain, head anchor, backup drift). Capped; O(history). */
export async function readAllEvents(root: string): Promise<{ events: EventRecord[]; problems: string[] }> {
  const store = await openEventLog(root);
  const meta = readyEventLogMeta(store);
  const events: EventRecord[] = [];
  let bytes = 0;
  for await (const row of store.scan({ prefix: EVENT_PREFIX })) {
    const record = checkedEventRecord(row.v);
    bytes += Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
    if (bytes >= MAX_EVENT_STORE_BYTES) throw new HistoryMaterializationTooLargeError("event", MAX_EVENT_STORE_BYTES);
    events.push(record);
  }
  const problems: string[] = [];
  const chain = verifyEventChain(events);
  if (!chain.ok && chain.problem) problems.push(chain.problem);
  const anchor = await readHeadAnchorFrom(diskHeadAnchorSources(root));
  if (anchor !== meta.headDigest) problems.push(`head anchor ${anchor ?? "<absent>"} does not match last event`);
  if (!(await legacyUnchanged(root, meta.legacy, store.counters))) problems.push(legacyDriftMessage(meta.legacy));
  return { events, problems };
}

/** Events after index `after` (-1 for the start), at most `limit` (normalized, capped). Bounded. */
export async function readEventsPage(root: string, after: number, limit: number): Promise<{ events: EventRecord[]; next?: number }> {
  if (!Number.isSafeInteger(after) || after < -1) throw new Error("readEventsPage: after must be an integer >= -1");
  const store = await openEventLog(root);
  readyEventLogMeta(store);
  const take = pageSize(limit, MAX_EVENT_PAGE);
  const events: EventRecord[] = [];
  let last = after;
  for await (const row of store.scan({ prefix: EVENT_PREFIX, ...(after < 0 ? {} : { after: indexKey(EVENT_PREFIX, after) }) })) {
    if (events.length >= take) return { events, next: last };
    events.push(checkedEventRecord(row.v));
    last = keyIndex(EVENT_PREFIX, row.k);
  }
  return { events };
}

/** The events bound to `mutationId` from the binding index, each cross-checked, stopping at a proved duplicate. */
export async function findEventsByMutation(root: string, mutationId: string, store?: SegmentStore): Promise<EventRecord[]> {
  const log = store ?? await openEventLog(root);
  readyEventLogMeta(log);
  const prefix = `m${mutationId}:`;
  const events: EventRecord[] = [];
  for await (const row of log.scan({ prefix })) {
    const record = checkedEventRecord(await log.get(indexKey(EVENT_PREFIX, keyIndex(prefix, row.k))));
    if (record.operationBinding?.mutationId !== mutationId) throw new Error(`event binding index disagrees with event ${record.id}`);
    events.push(record);
    if (events.length >= DUPLICATE_PROOF) break;
  }
  return events;
}

/** What one full verification found, for this response only. */
export interface HistoryVerification {
  readonly ok: boolean;
  readonly records: number;
  readonly problemCount: number;
  readonly problems: readonly string[];
  /** The store's on-disk inventory, present when its full verification reached the segment check. */
  readonly storage?: StorageInventoryV1;
}

/** Check one streamed event against the chain and its binding row. */
async function checkEvent(store: SegmentStore, record: EventRecord, index: number, expected: string, problems: ProblemSample): Promise<void> {
  if (record.prevHash !== expected) problems.note(`chain link broken at event ${index} (${record.id})`);
  const binding = record.operationBinding;
  if (binding !== undefined && (await store.get(bindingKey(binding.mutationId, index))) === undefined) problems.note(`event ${record.id} is missing its binding index row`);
}

/** Stream every record once (bounded memory): checksums, chain from genesis, binding rows, segment digests, anchor, backup bytes. */
export async function verifyEventHistory(root: string): Promise<HistoryVerification> {
  return withVerificationReads(await openEventLog(root), (store) => verifyEventStore(root, store));
}

/** {@link verifyEventHistory} over one (verification-cached) snapshot. */
async function verifyEventStore(root: string, store: SegmentStore): Promise<HistoryVerification> {
  const meta = readyEventLogMeta(store);
  const problems = new ProblemSample();
  let expected = GENESIS_PREV_HASH;
  let count = 0;
  for await (const row of store.scan({ prefix: EVENT_PREFIX })) {
    const record = checkedEventRecord(row.v);
    if (keyIndex(EVENT_PREFIX, row.k) !== count) problems.note(`event index gap at ${row.k}`);
    await checkEvent(store, record, count, expected, problems);
    expected = eventPrevHash(record);
    count += 1;
  }
  if (count !== meta.count || (count > 0 && expected !== meta.headDigest)) problems.note("the manifest head does not match the stored records");
  const storage = storageOf(await verifyStore(store));
  if ((await readHeadAnchorFrom(diskHeadAnchorSources(root))) !== meta.headDigest) problems.note("head anchor does not match the last event");
  if (!(await legacyBytesUnchanged(root, meta.legacy, MAX_EVENT_STORE_BYTES))) problems.note(legacyDriftMessage(meta.legacy));
  return { ok: problems.count === 0, records: count, problemCount: problems.count, problems: problems.sample, storage };
}
