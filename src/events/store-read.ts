/**
 * @file src/events/store-read.ts
 * @description The READ half of the hash-chained event store: parse the
 * append-only JSONL at `wiki/graph/events.jsonl` into the ordered event list,
 * plus the chain/anchor verifiers PR2 surfaces through lint/status.
 *
 * Durability contract (mirrors the relation store):
 *  - FIRST line is a header carrying `schemaVersion`; a version greater than
 *    {@link EVENT_STORE_SCHEMA_VERSION} → FAIL CLOSED ({@link EventStoreTooNewError}).
 *  - Every record carries a CHECKSUM, recomputed on read; a bad checksum or a
 *    malformed record BEFORE the final line is interior corruption → FAIL CLOSED
 *    ({@link EventStoreCorruptError}).
 *  - A torn TRAILING line is TOLERATED and REPORTED as a `problem`.
 *  - The graph dir's realpath is confined; a symlinked leaf/dir fails closed.
 *  - Absent file → empty result.
 *
 * CHAIN: unlike corruption, a broken/forked/reordered chain or a head-anchor
 * mismatch does NOT throw from {@link readEvents} — it is returned as a `problem`
 * so a later lint/status surface (PR2) can report it. Callers that DEMAND an
 * intact chain run {@link verifyEventChain}/{@link verifyHeadAnchor} and throw
 * {@link EventStoreChainError} themselves.
 */

import path from "path";
import { EVENTS_FILE, EVENTS_HEAD_FILE, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { resolveConfinedPrivateDir } from "../utils/private-dir.js";
import { readConfinedGraphStore, splitStoreRecords } from "../utils/jsonl-store.js";
import type { EventRecord } from "./types.js";
import {
  EVENT_STORE_SCHEMA_VERSION,
  GENESIS_PREV_HASH,
  EventStoreTooNewError,
  EventStoreCorruptError,
  EventStoreSymlinkError,
  EventStoreChainError,
} from "./types.js";
import { eventChecksum, openEventFileRead } from "./store-record.js";
import { eventPrevHash } from "./event-digest.js";

/** The outcome of reading the store: ordered events plus any tolerated/surfaced problems. */
export interface ReadEventsResult {
  /** Events in append (file) order. */
  events: EventRecord[];
  /** Human-readable notes (torn trailing line, chain break, head mismatch). */
  problems: string[];
}

/** Read the raw store bytes, or null when absent — via the shared confined+capped reader. */
function readStoreFile(root: string): Promise<string | null> {
  return readConfinedGraphStore(root, {
    fileName: path.basename(EVENTS_FILE),
    makeSymlinkError: (reason) => new EventStoreSymlinkError(reason),
    maxBytes: MAX_RELATION_STORE_BYTES,
    makeOversizeError: (size) =>
      new EventStoreCorruptError(`store file ${size} bytes exceeds the ${MAX_RELATION_STORE_BYTES}-byte cap`),
  });
}

/** Parse and validate the header line, failing closed on an unknown future version. */
function parseHeader(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventStoreCorruptError("header line is not valid JSON");
  }
  const header = parsed as { kind?: unknown; schemaVersion?: unknown };
  if (header.kind !== "event-store-header" || typeof header.schemaVersion !== "number") {
    throw new EventStoreCorruptError("first line is not a valid store header");
  }
  if (header.schemaVersion > EVENT_STORE_SCHEMA_VERSION) {
    throw new EventStoreTooNewError(header.schemaVersion, EVENT_STORE_SCHEMA_VERSION);
  }
}

/** Parse one record line into an {@link EventRecord}, validating its required shape. */
function parseRecord(line: string): EventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventStoreCorruptError("record line is not valid JSON");
  }
  const rec = parsed as Partial<EventRecord>;
  const idOk = typeof rec.id === "string" && rec.id.startsWith("evt_");
  if (!idOk || typeof rec.checksum !== "string" || typeof rec.prevHash !== "string" || typeof rec.type !== "string") {
    throw new EventStoreCorruptError("record line is missing required fields");
  }
  return rec as EventRecord;
}

/** Verify a parsed record's stored checksum; throw {@link EventStoreCorruptError} on mismatch. */
function verifyChecksum(record: EventRecord): EventRecord {
  const { checksum, ...rest } = record;
  if (eventChecksum(rest) !== checksum) {
    throw new EventStoreCorruptError(`checksum mismatch for event ${record.id}`);
  }
  return record;
}

/**
 * Parse every record line AFTER the header. A failure on any line except the LAST
 * is interior corruption (fail closed); a failure on the last line is a torn
 * trailing append — tolerated, reported via `problems`.
 */
function parseRecords(lines: string[], problems: string[]): EventRecord[] {
  const events: EventRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    try {
      events.push(verifyChecksum(parseRecord(lines[i])));
    } catch (err) {
      if (isLast) {
        problems.push(`tolerated torn trailing line: ${(err as Error).message}`);
        break;
      }
      throw err; // interior corruption → fail closed
    }
  }
  return events;
}

/**
 * Verify the hash chain over `events` (file order): the first record's `prevHash`
 * must equal {@link GENESIS_PREV_HASH}, and each subsequent record's `prevHash`
 * must equal the chain digest of its predecessor ({@link eventPrevHash}). An edit,
 * reorder, deletion, or fork changes a digest and breaks a link.
 *
 * @param events - Events in append order.
 * @returns `{ ok }`, with a `problem` describing the first broken link when not ok.
 */
export function verifyEventChain(events: EventRecord[]): { ok: boolean; problem?: string } {
  for (let i = 0; i < events.length; i++) {
    const expected = i === 0 ? GENESIS_PREV_HASH : eventPrevHash(events[i - 1]);
    if (events[i].prevHash !== expected) {
      return { ok: false, problem: `chain link broken at event ${i} (${events[i].id})` };
    }
  }
  return { ok: true };
}

/** Read the sealed head-anchor digest, or null when it is absent. Confined + no-follow. */
async function readHeadAnchor(root: string): Promise<string | null> {
  const dir = await resolveConfinedPrivateDir(root); // throws on .llmwiki symlink escape
  const file = path.join(dir, path.basename(EVENTS_HEAD_FILE));
  const handle = await openEventFileRead(file); // no-follow; symlink → fail closed
  if (handle === null) return null;
  try {
    return (await handle.readFile("utf-8")).trim();
  } finally {
    await handle.close();
  }
}

/**
 * Verify the sealed HEAD anchor matches the LAST event: the anchor (the digest of
 * the last event, written under `.llmwiki/events.head`) must equal
 * {@link eventPrevHash} of the last event. A TRUNCATED log (last record dropped)
 * or a wholesale rewrite leaves the anchor pointing at a now-absent digest, so
 * the mismatch is detected. An empty store with no anchor is consistent (`ok`).
 *
 * @param root - Absolute project root.
 * @param events - Events in append order (the last is anchored).
 * @returns `{ ok }`, with a `problem` when the anchor and last event disagree.
 */
export async function verifyHeadAnchor(
  root: string,
  events: EventRecord[],
): Promise<{ ok: boolean; problem?: string }> {
  const anchor = await readHeadAnchor(root);
  const expected = events.length === 0 ? null : eventPrevHash(events[events.length - 1]);
  if (anchor === expected) return { ok: true };
  return { ok: false, problem: `head anchor ${anchor ?? "<absent>"} does not match last event` };
}

/** Append chain + head-anchor problems (non-fatal) onto `problems`. */
async function appendChainProblems(root: string, events: EventRecord[], problems: string[]): Promise<void> {
  const chain = verifyEventChain(events);
  if (!chain.ok && chain.problem) problems.push(chain.problem);
  const anchor = await verifyHeadAnchor(root, events);
  if (!anchor.ok && anchor.problem) problems.push(anchor.problem);
}

/**
 * Read the event store into the ordered events plus any problems. Corruption /
 * too-new / symlink fail CLOSED (throw); a torn trailing line, a broken chain,
 * and a head-anchor mismatch are returned as `problems` (PR2 surfaces them).
 *
 * @param root - Absolute project root.
 * @returns The events in append order and a list of problems.
 */
export async function readEvents(root: string): Promise<ReadEventsResult> {
  const raw = await readStoreFile(root); // throws on symlink/too-new/corrupt
  const recordLines = splitStoreRecords(raw, parseHeader);
  // An ABSENT or header-only log yields ZERO events — but if the sealed head
  // anchor still points at a real digest, a prior log was TRUNCATED to empty
  // (not a fresh project). Run the head-anchor check on the empty list so that
  // truncation surfaces as a head-mismatch problem instead of a healthy empty.
  if (recordLines === null) {
    const emptyProblems: string[] = [];
    await appendChainProblems(root, [], emptyProblems);
    return { events: [], problems: emptyProblems };
  }
  const problems: string[] = [];
  const events = parseRecords(recordLines, problems);
  await appendChainProblems(root, events, problems);
  return { events, problems };
}

/**
 * Read the event store and FAIL CLOSED on a broken chain or head-anchor mismatch.
 * The strict entry point for callers that demand a tamper-intact audit log:
 * delegates to {@link readEvents} (so corruption/too-new/symlink still throw their
 * own errors), then throws {@link EventStoreChainError} if any chain/anchor
 * problem was surfaced. A torn TRAILING line alone is tolerated — only chain /
 * head-anchor problems escalate to a throw.
 *
 * @param root - Absolute project root.
 * @returns The events in append order (when the chain + anchor are intact).
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
export async function readEventsStrict(root: string): Promise<EventRecord[]> {
  const { events } = await readEvents(root);
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const anchor = await verifyHeadAnchor(root, events);
  if (!anchor.ok) throw new EventStoreChainError(anchor.problem ?? "head anchor mismatch");
  return events;
}
