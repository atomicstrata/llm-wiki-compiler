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
 * WRITE PRECONDITION (repair-then-verify): {@link appendEventLocked} runs
 * {@link prepareEventStoreForAppend} first. A torn TRAILING line (an uncommitted,
 * crashed prior append) is REPAIRED — truncated to the last valid record — so the
 * new event never concatenates onto a partial line and corrupts the log. After
 * repair it FAILS CLOSED on actual tamper (a tampered/truncated/corrupt store
 * throws BEFORE any append). This prevents re-sealing the head over a tampered
 * chain (which would "launder" the tamper). A healthy chain still appends
 * normally; reads keep TOLERATING a torn tail (they never extend it).
 *
 * ORDERING: emit sites call this AFTER the durable mutation has landed, so the
 * event trails the mutation. A crash between the mutation and the append leaves a
 * missing trailing event — the torn-trailing case the reader tolerates and reports.
 */

import { mkdir } from "fs/promises";
import path from "path";
import { EVENTS_FILE, EVENTS_HEAD_FILE } from "../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { atomicWrite } from "../utils/markdown.js";
import { ulid } from "../relations/ulid.js";
import type { EventContent, EventId, EventRecord, EventType } from "./types.js";
import { GENESIS_PREV_HASH } from "./types.js";
import {
  eventChecksum,
  eventHeaderLine,
  serializeEventRecord,
  resolveEventGraphDir,
  openEventFileAppend,
  type EventChecksumInput,
} from "./store-record.js";
import { eventPrevHash } from "./event-digest.js";
import { prepareEventStoreForAppend } from "./store-read.js";

/** The caller-supplied content of a new event (id, prevHash, checksum are derived). */
export interface AppendEventInput {
  type: EventType;
  origin: string;
  actor?: string;
  payload: Record<string, unknown>;
  decision?: string;
  /** ISO-8601 emit timestamp; the caller supplies one (e.g. `new Date().toISOString()`). */
  at: string;
}

/** Whether the caller already holds the project lock (skip the nested acquire). */
export interface RecordEventOptions {
  locked?: boolean;
}

/** Mint a fresh `evt_<ULID>` id, allocated once at emit. */
function mintEventId(): EventId {
  return `evt_${ulid()}`;
}

/** The chain digest of the LAST event (or {@link GENESIS_PREV_HASH} for an empty store). */
function prevHashFor(events: EventRecord[]): string {
  if (events.length === 0) return GENESIS_PREV_HASH;
  return eventPrevHash(events[events.length - 1]);
}

/** Build the chained, checksummed {@link EventRecord} from caller input + the prior digest. */
function buildEventRecord(input: AppendEventInput, prevHash: string): EventRecord {
  const content: EventContent = {
    id: mintEventId(),
    type: input.type,
    origin: input.origin,
    actor: input.actor,
    payload: input.payload,
    decision: input.decision,
    at: input.at,
  };
  const unchecked: EventChecksumInput = { ...content, prevHash };
  return { ...unchecked, checksum: eventChecksum(unchecked) };
}

/** Append one record line to the store under O_APPEND, creating the dir/header. */
async function appendLine(root: string, record: EventRecord): Promise<void> {
  const { dir } = await resolveEventGraphDir(root); // throws on symlink escape (DIR)
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(EVENTS_FILE));
  const handle = await openEventFileAppend(file); // throws on symlink leaf (LEAF)
  try {
    const existing = (await handle.stat()).size;
    if (existing === 0) await handle.write(eventHeaderLine());
    const { checksum, ...rest } = record;
    void checksum; // serializeEventRecord recomputes from the content fields
    await handle.write(serializeEventRecord(rest));
  } finally {
    await handle.close();
  }
}

/** Seal the new record's chain digest into the confined `.llmwiki/events.head` anchor. */
async function sealHeadAnchor(root: string, content: EventContent): Promise<void> {
  await atomicWrite(path.join(root, EVENTS_HEAD_FILE), eventPrevHash(content), { confineRoot: root });
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
  // WRITE precondition: REPAIR a torn trailing line (an uncommitted, crashed
  // prior append) by truncating it BEFORE we chain — otherwise the new record
  // would concatenate onto the partial line and corrupt the log. After repair,
  // prepareEventStoreForAppend FAILS CLOSED on actual tamper (broken/reordered/
  // truncated chain, head mismatch) and the store's typed errors (corrupt /
  // too-new / symlink) — so a tampered chain still cannot be laundered.
  const events = await prepareEventStoreForAppend(root); // under the caller's lock
  const record = buildEventRecord(input, prevHashFor(events));
  await appendLine(root, record);
  await sealHeadAnchor(root, record);
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
  await acquireLockBlocking(root); // throws LockBusyError on timeout
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
