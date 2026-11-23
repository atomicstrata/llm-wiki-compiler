/**
 * @file src/events/store.ts
 * @description The WRITE half of the append-only, hash-chained EVENT store.
 * Builds an {@link EventRecord} (minting an `evt_<ULID>` id, chaining `prevHash`
 * to the prior record's digest, computing the per-record checksum), APPENDS it to
 * `wiki/graph/events.jsonl` through the shared NO-FOLLOW O_APPEND primitive
 * (writing the header first when the store is empty), then SEALS the new record's
 * digest into the head anchor at `.llmwiki/events.head`.
 *
 * LOCKING: {@link appendEventLocked} is the lock-free core — it MUST run under a
 * lock the CALLER already holds, so an emit site that already holds the project
 * lock for its mutation (a lifecycle transition / relation append) co-commits the
 * event without a nested-acquire deadlock. {@link appendEvent} is the self-locking
 * entry point. {@link recordEvent} dispatches between them on `opts.locked`.
 *
 * WRITE PRECONDITION (verify-then-repair): {@link appendEventLocked} runs
 * {@link prepareEventStoreForAppendFrom} first. It VERIFIES the chain BEFORE any
 * repair, so a tampered/reordered chain throws BEFORE any append with the file
 * left BYTE-IDENTICAL (no re-sealing the head over a tampered chain — no
 * laundering). Only then are two UNCOMMITTED trailing states repaired: a torn
 * TRAILING line (a crashed prior append, truncated to the last valid record so the
 * new event never concatenates onto a partial line) AND the one-record-AHEAD crash
 * state (a complete record the head never sealed because a crash hit between
 * `appendLine` and `sealHeadAnchor` — dropped, since the head SEAL is the commit
 * point). Reads keep TOLERATING a torn tail (they never extend it).
 *
 * ORDERING: emit sites call this AFTER the durable mutation has landed, so the
 * event trails the mutation. A crash between the mutation and the append leaves a
 * missing trailing event — the torn-trailing case the reader tolerates and reports.
 * A crash between the append and the head seal leaves a one-ahead store, recovered
 * (the uncommitted record dropped) on the next write.
 *
 * SIZE CEILING: the append-only log has a hard size ceiling ({@link MAX_EVENT_STORE_BYTES}
 * for the whole file, {@link MAX_EVENT_RECORD_BYTES} per record). An append that
 * would reach/exceed either cap throws {@link EventStoreFullError} BEFORE writing,
 * so the store can never be driven past the read cap into a bricked state. ROTATION
 * and ARCHIVAL of an exhausted log are documented future items — not implemented here.
 *
 * ONE BODY over raw sources: {@link appendEventLocked} and
 * {@link preflightEventAppend} run {@link appendEventLockedFrom} and
 * {@link preflightEventAppendFrom} over local-disk {@link EventWriteSources}:
 * the repair sources plus the handle-held store append, the store's no-follow
 * byte size, and the head seal. Every decision (the chain, the repair, the
 * header choice, both caps, the record bytes, and the order append-then-seal)
 * stays in this file; the sources only answer. The disk members reach the
 * event-typed wrappers in `./store-record.ts` and `atomicWrite` through
 * `../utils/markdown.js` at call time. The operation-bound append runs
 * {@link appendBoundEventLockedFrom} over {@link EventBoundWriteSources}: the
 * same write sources plus the DURABLE whole-store replacement its header upgrade
 * (`./store-version.ts`) asks for, kept a member of its own.
 */

import path from "path";
import { EVENTS_FILE, EVENTS_HEAD_FILE, MAX_EVENT_RECORD_BYTES, MAX_EVENT_STORE_BYTES } from "../utils/constants.js";
import { assertOperationBinding, type OperationBinding } from "../utils/operation-binding.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { atomicWrite } from "../utils/markdown.js";
import { appendToGraphLeaf, type GraphStoreAppend } from "../utils/jsonl-store.js";
import type { EventContent, EventId, EventRecord, EventType } from "./types.js";
import { GENESIS_PREV_HASH, EventStoreFullError } from "./types.js";
import {
  eventChecksum,
  eventHeaderLine,
  serializeEventRecord,
  resolveEventGraphDir,
  openEventFileAppend,
  openEventFileRead,
  type EventChecksumInput,
} from "./store-record.js";
import { eventPrevHash } from "./event-digest.js";
import { assertRecordWithinCap, buildEventRecord, prevHashFor, type AppendEventInput } from "./event-build.js";
import { diskEventRepairSources, prepareEventStoreForAppendFrom, type EventRepairSources } from "./store-read.js";
import { diskEventUpgradeSources, ensureEventOperationVersionLockedFrom, type EventUpgradeSources } from "./store-version.js";

export type { AppendEventInput } from "./event-build.js";

/** Whether the caller already holds the project lock (skip the nested acquire). */
export interface RecordEventOptions {
  locked?: boolean;
}

/**
 * Reject an append when the PROJECTED store size (current + new bytes) would
 * reach or exceed {@link MAX_EVENT_STORE_BYTES} — the same ceiling the reader
 * enforces, so the store can never be driven into an unreadable-yet-appendable
 * (bricked) state. Throws {@link EventStoreFullError} BEFORE any write.
 */
function assertStoreNotFull(existing: number, addition: number): void {
  if (existing + addition >= MAX_EVENT_STORE_BYTES) {
    throw new EventStoreFullError();
  }
}

/**
 * Everything the event WRITE bodies ask for: the repair sources, the
 * handle-held store append ({@link GraphStoreAppend}), and two raw members.
 * Owned by the event store; not `ProjectStore`, not hosted, and it selects no
 * backend. Each member answers physically and decides nothing.
 */
export interface EventWriteSources extends EventRepairSources, GraphStoreAppend {
  /**
   * The store leaf's byte size, 0 when the leaf is absent. A link or a
   * non-regular leaf REJECTS with the event store's typed error; anything else
   * REJECTS raw. Disk: resolve the confined graph directory (no `mkdir`), then
   * ALWAYS the no-follow read-open (`ENOENT`, and only that, is 0), the handle
   * `fstat`, and the close in `finally`.
   */
  storeByteSize(): Promise<number>;
  /**
   * Replace the head anchor with `digest`. Atomic, NOT durable. REJECTS raw.
   * Disk: the confined `atomicWrite` of `<root>/.llmwiki/events.head` (the root
   * as given, not resolved), confined to the root.
   */
  sealHead(digest: string): Promise<void>;
}

/**
 * LOCAL DISK. The write sources for the project at `root`. The append reaches
 * `resolveEventGraphDir` and `openEventFileAppend` (`./store-record.ts`), the
 * size reaches `resolveEventGraphDir` and `openEventFileRead`, and the seal
 * reaches `atomicWrite` (`../utils/markdown.js`), each at call time. Building
 * them does no I/O. In no package index.
 */
export function diskEventWriteSources(root: string): EventWriteSources {
  return {
    ...diskEventRepairSources(root),
    appendStore: (plan) => appendToGraphLeaf({
      resolveDir: () => resolveEventGraphDir(root), // throws on symlink escape (DIR)
      openAppend: (file) => openEventFileAppend(file), // throws on symlink leaf (LEAF)
      fileName: path.basename(EVENTS_FILE),
    }, plan),
    storeByteSize: () => eventStoreByteSize(root),
    sealHead: (digest) => atomicWrite(path.join(root, EVENTS_HEAD_FILE), digest, { confineRoot: root }),
  };
}

/**
 * The chunks one event append writes, for a store leaf of `existing` bytes:
 * the header only when the leaf is empty, then the record. Lazy: nothing runs
 * until the first chunk is pulled, which happens after the leaf was opened and
 * its size taken, so the caps are checked AFTER the open (an over-cap record
 * still leaves a created empty leaf, as it always did) and BEFORE any write.
 */
function* eventChunks(existing: number, record: EventRecord): Generator<string> {
  const header = existing === 0 ? eventHeaderLine() : "";
  const { checksum, ...rest } = record;
  void checksum; // serializeEventRecord recomputes from the content fields
  const serialized = serializeEventRecord(rest);
  assertRecordWithinCap(serialized); // per-record cap BEFORE any write
  assertStoreNotFull(existing, Buffer.byteLength(header + serialized, "utf8")); // projected-size cap
  if (header) yield header;
  yield serialized;
}

/** Append one record line through the sources' handle-held append (header first on an empty leaf). */
function appendRecordFrom(sources: GraphStoreAppend, record: EventRecord): Promise<void> {
  return sources.appendStore((existing) => eventChunks(existing, record));
}

/**
 * Everything {@link appendBoundEventLockedFrom} asks for: the event write
 * sources plus the DURABLE whole-store replacement of the header upgrade. The
 * durable and the non-durable replacement stay two members.
 */
export interface EventBoundWriteSources extends EventWriteSources, EventUpgradeSources {}

/**
 * LOCAL DISK. The bound-append sources for the project at `root`: the write
 * sources and the upgrade's durable replacement (`./store-version.ts`, through
 * `../utils/atomic-write.js`). Building them does no I/O. In no package index.
 */
export function diskEventBoundWriteSources(root: string): EventBoundWriteSources {
  return { ...diskEventWriteSources(root), replaceStoreDurable: diskEventUpgradeSources(root).replaceStoreDurable };
}

/**
 * Build the would-be record for `input` and run the EXACT same per-record and
 * projected-store size checks the append's chunks run — WITHOUT writing anything.
 * The read-only preflight a cross-store emit site uses to fail a mutation CLOSED
 * (with its OTHER store untouched) when the audit event it must emit afterwards
 * would exceed {@link MAX_EVENT_RECORD_BYTES} or drive the log past
 * {@link MAX_EVENT_STORE_BYTES}. It chains `prevHash` off the current head exactly
 * as the real append would, so the serialized record it checks is byte-for-byte
 * the one that would land. MUST run under the caller's lock so the head it reads is
 * the head the subsequent append will chain from.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param input - The new event's content (the same value passed to the append).
 * @throws {EventStoreFullError} When the would-be record exceeds the per-record
 *   cap or would drive the store past its size ceiling.
 */
export async function preflightEventAppend(root: string, input: AppendEventInput): Promise<void> {
  await preflightEventAppendFrom(diskEventWriteSources(root), input);
}

/**
 * {@link preflightEventAppend} over {@link EventWriteSources}: THE ONE BODY. The
 * repair precondition, the would-be record, the per-record cap, THEN the size
 * look, then the projected-store cap. Writes nothing beyond what the repair
 * precondition itself may truncate.
 *
 * @param sources - The event write sources (the caller holds its lock).
 * @param input - The new event's content (the same value passed to the append).
 * @throws {EventStoreFullError} When the would-be record exceeds the per-record
 *   cap or would drive the store past its size ceiling.
 */
export async function preflightEventAppendFrom(sources: EventWriteSources, input: AppendEventInput): Promise<void> {
  const segmented = await sources.segmented?.();
  if (segmented) return segmented.preflight(input);
  const events = await prepareEventStoreForAppendFrom(sources); // under the caller's lock
  const record = buildEventRecord(input, prevHashFor(events));
  const serialized = serializeEventRecord(stripChecksum(record));
  assertRecordWithinCap(serialized); // per-record cap — EXACT check from appendLine
  const existing = await sources.storeByteSize();
  const header = existing === 0 ? eventHeaderLine() : "";
  assertStoreNotFull(existing, Buffer.byteLength(header + serialized, "utf8")); // projected-size cap
}

/** The no-follow byte size of the event store leaf: the confined dir (no `mkdir`), then ALWAYS the read-open. */
async function eventStoreByteSize(root: string): Promise<number> {
  const { dir } = await resolveEventGraphDir(root);
  return eventFileSize(path.join(dir, path.basename(EVENTS_FILE)));
}

/** Drop the stored `checksum` so {@link serializeEventRecord} recomputes it from the content. */
function stripChecksum(record: EventRecord): EventChecksumInput {
  const { checksum, ...rest } = record;
  void checksum;
  return rest;
}

/** The byte size of the event store file, treating an absent file as zero. */
async function eventFileSize(file: string): Promise<number> {
  const handle = await openEventFileRead(file); // no-follow; symlink → fail closed
  if (handle === null) return 0;
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

/**
 * Append one event to the chained store WHILE THE CALLER ALREADY HOLDS the project
 * lock (the lock-free core). Reads the current events to chain `prevHash` off the
 * last record's digest, appends the new record, then seals its digest into the
 * head anchor. The caller MUST already hold the lock; this acquires NOTHING, so an
 * emit site can co-commit the event inside its mutation's lock region.
 *
 * @param root - Absolute project root.
 * @param input - The new event's content.
 * @returns The persisted {@link EventRecord}.
 */
export async function appendEventLocked(root: string, input: AppendEventInput): Promise<EventRecord> {
  return appendEventLockedFrom(diskEventWriteSources(root), input);
}

/**
 * {@link appendEventLocked} over {@link EventWriteSources}: THE ONE BODY. The
 * repair precondition, the chained record, the append, then the seal (the
 * commit point). The caller MUST already hold the project lock.
 *
 * @param sources - The event write sources.
 * @param input - The new event's content.
 * @returns The persisted {@link EventRecord}.
 */
export async function appendEventLockedFrom(sources: EventWriteSources, input: AppendEventInput): Promise<EventRecord> {
  const segmented = await sources.segmented?.();
  if (segmented) return segmented.append(input); // local-indexed: the segmented log (bounded tail checks)
  // WRITE precondition (verify-then-repair): prepareEventStoreForAppendFrom VERIFIES
  // the chain FIRST, so a broken/reordered chain or a non-recoverable head/log
  // mismatch FAILS CLOSED with the file BYTE-IDENTICAL (a tampered chain is never
  // laundered). It then repairs only UNCOMMITTED trailing state before we chain: a
  // torn trailing line (otherwise the new record concatenates onto the partial
  // line and corrupts the log) and the bounded one-record-AHEAD crash state (a
  // complete record the head never sealed — dropped, since the seal is the commit
  // point). Typed errors (corrupt / too-new / symlink) still throw.
  const events = await prepareEventStoreForAppendFrom(sources); // under the caller's lock
  const record = buildEventRecord(input, prevHashFor(events));
  await appendRecordFrom(sources, record);
  await sources.sealHead(eventPrevHash(record));
  return record;
}

/**
 * Append one operation-bound event WHILE THE CALLER ALREADY HOLDS the project
 * lock. The store header is upgraded to the operation schema version first (so a
 * v1 store never gains a bound record under a v1 header), the torn/one-ahead tail
 * is repaired by {@link prepareEventStoreForAppendFrom}, and the record carries the
 * validated {@link OperationBinding} covered by the chain digest and checksum.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param input - The new event's content (binding-free; the binding is out-of-band).
 * @param binding - The operation binding to stamp onto the record.
 * @returns The persisted {@link EventRecord}.
 */
export async function appendBoundEventLocked(
  root: string,
  input: AppendEventInput,
  binding: OperationBinding,
): Promise<EventRecord> {
  return appendBoundEventLockedFrom(diskEventBoundWriteSources(root), input, binding);
}

/**
 * {@link appendBoundEventLocked} over {@link EventBoundWriteSources}: THE ONE
 * BODY. The binding check, the repair precondition, the DURABLE header upgrade,
 * the chained bound record, the append, then the seal.
 *
 * @param sources - The bound-append sources (the caller holds its lock).
 * @param input - The new event's content (binding-free; the binding is out-of-band).
 * @param binding - The operation binding to stamp onto the record.
 * @returns The persisted {@link EventRecord}.
 */
export async function appendBoundEventLockedFrom(
  sources: EventBoundWriteSources,
  input: AppendEventInput,
  binding: OperationBinding,
): Promise<EventRecord> {
  const checked = assertOperationBinding(binding);
  const segmented = await sources.segmented?.();
  if (segmented) return segmented.append(input, checked); // local-indexed: the segmented log
  const events = await prepareEventStoreForAppendFrom(sources); // under the caller's lock
  await ensureEventOperationVersionLockedFrom(sources); // upgrade header, records preserved
  const record = buildEventRecord(input, prevHashFor(events), checked);
  await appendRecordFrom(sources, record);
  await sources.sealHead(eventPrevHash(record));
  return record;
}

/**
 * Append one event, self-locking via {@link acquireLockBlocking}/{@link releaseLock}.
 * The entry point for callers that do NOT already hold the lock.
 *
 * @param root - Absolute project root.
 * @param input - The new event's content.
 * @returns The persisted {@link EventRecord}.
 */
export async function appendEvent(root: string, input: AppendEventInput): Promise<EventRecord> {
  await acquireMutationLockBlocking(root, "ordinary"); // throws LockBusyError on timeout
  try {
    return await appendEventLocked(root, input);
  } finally {
    await releaseLock(root);
  }
}

/**
 * Record an event, dispatching on whether the caller already holds the lock:
 * `opts.locked` uses the lock-free {@link appendEventLocked} (an emit site inside
 * a held mutation lock), otherwise the self-locking {@link appendEvent}.
 *
 * @param root - Absolute project root.
 * @param input - The new event's content.
 * @param opts - When `locked`, skip the nested acquire (caller holds the lock).
 * @returns The persisted {@link EventRecord}.
 */
export function recordEvent(
  root: string,
  input: AppendEventInput,
  opts: RecordEventOptions = {},
): Promise<EventRecord> {
  return opts.locked ? appendEventLocked(root, input) : appendEvent(root, input);
}
