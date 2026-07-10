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
import { EVENTS_FILE, EVENTS_HEAD_FILE, MAX_RELATION_STORE_BYTES, MAX_EVENT_HEAD_BYTES } from "../utils/constants.js";
import { resolveExistingConfinedPrivateDir, PrivateDirConfinementError } from "../utils/private-dir.js";
import { readConfinedGraphStore, splitStoreRecords } from "../utils/jsonl-store.js";
import { atomicWrite } from "../utils/markdown.js";
import type { EventRecord } from "./types.js";
import {
  EVENT_STORE_SCHEMA_VERSION,
  GENESIS_PREV_HASH,
  EventStoreTooNewError,
  EventStoreCorruptError,
  EventStoreSymlinkError,
  EventStoreChainError,
} from "./types.js";
import {
  eventChecksum,
  openEventFileRead,
  serializeEventRecord,
  eventHeaderLine,
} from "./store-record.js";
import { eventPrevHash } from "./event-digest.js";

/** The substring {@link readEvents} prefixes onto a tolerated torn-trailing-line problem. */
const TORN_TAIL_MARKER = "torn trailing line";

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

/** Read the sealed head-anchor digest, or null when it is absent. Confined + no-follow + capped. */
async function readHeadAnchor(root: string): Promise<string | null> {
  const dir = await resolveExistingConfinedPrivateDir(root); // throws on .llmwiki symlink escape
  if (dir === null) return null; // absent .llmwiki → no head anchor, clean project
  const file = path.join(dir, path.basename(EVENTS_HEAD_FILE));
  const handle = await openEventFileRead(file); // no-follow; symlink → fail closed
  if (handle === null) return null;
  try {
    const size = (await handle.stat()).size;
    if (size > MAX_EVENT_HEAD_BYTES) {
      throw new EventStoreCorruptError(
        `head anchor file ${size} bytes exceeds the ${MAX_EVENT_HEAD_BYTES}-byte cap`,
      );
    }
    return (await handle.readFile("utf-8")).trim();
  } finally {
    await handle.close();
  }
}

/**
 * Verify the sealed HEAD anchor matches the LAST event: the anchor (the digest of
 * the last event, written under `.llmwiki/events.head`) must equal
 * {@link eventPrevHash} of the last event. A TRUNCATED log (last record dropped)
 * is detected ONLY when the head is NOT also rewritten — i.e. against ACCIDENTAL
 * or PARTIAL truncation and torn writes, not against an adversary who rewrites
 * BOTH the log and this anchor (a truncate-and-reseal would pass; full
 * tamper-evidence needs an out-of-tree/signed anchor — a documented deferral, see
 * the {@link EventRecord} file overview). An empty store with no anchor is `ok`.
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
 * FAIL CLOSED on a broken chain or head-anchor mismatch over `events`. The shared
 * strict-verification core: throws {@link EventStoreChainError} on actual TAMPER
 * (broken/forked/reordered/interior-deleted chain, head-without-log, valid-but-
 * mismatched head). A torn trailing line is NOT a chain/anchor problem, so this
 * does not fire on it — the caller decides whether a torn tail is tolerated (read)
 * or repaired before verification (write).
 *
 * @param root - Absolute project root (for the head-anchor read).
 * @param events - Events in append order.
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
async function verifyChainAndHead(root: string, events: EventRecord[]): Promise<void> {
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const anchor = await verifyHeadAnchor(root, events);
  if (!anchor.ok) throw new EventStoreChainError(anchor.problem ?? "head anchor mismatch");
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
  await verifyChainAndHead(root, events);
  return events;
}

/** Whether `problems` reports a tolerated torn TRAILING line (an uncommitted append). */
function hasTornTail(problems: string[]): boolean {
  return problems.some((p) => p.includes(TORN_TAIL_MARKER));
}

/**
 * Rewrite the store body to the header + the `kept` records, dropping anything
 * after them. Uses the confined {@link atomicWrite} (temp + O_EXCL + rename,
 * `confineRoot` ancestor + parent-symlink defenses) so the truncation reuses the
 * hardened write discipline — no new unconfined write is introduced. The shared
 * truncation primitive for both torn-tail repair and one-ahead crash recovery; it
 * is only ever called on an UNCOMMITTED (un-sealed) tail, so it loses nothing.
 */
async function truncateToRecords(root: string, kept: EventRecord[]): Promise<void> {
  const body = eventHeaderLine() + kept.map((e) => serializeEventRecord(stripChecksum(e))).join("");
  await atomicWrite(path.join(root, EVENTS_FILE), body, { confineRoot: root });
}

/** Drop the stored `checksum` so {@link serializeEventRecord} recomputes it from the content. */
function stripChecksum(record: EventRecord): Omit<EventRecord, "checksum"> {
  const { checksum, ...rest } = record;
  void checksum;
  return rest;
}

/**
 * The classification of the sealed head relative to the (chain-verified) `events`:
 *  - `"healthy"`: the head seals the LAST record (or no head over an empty log) —
 *    the normal, committed state.
 *  - `"one-ahead"`: the head seals exactly the (N-1)-record PREFIX, so the LAST
 *    record is a single UNCOMMITTED trailing record from a crash between
 *    `appendLine` and `sealHeadAnchor` (or, for N=1 with no head, a first-ever
 *    append that crashed before sealing) — recoverable by dropping that record.
 *  - `"tamper"`: anything else — a head/log mismatch that is not the bounded
 *    one-ahead crash state, so it must be rejected with the file byte-identical.
 */
type HeadState = "healthy" | "one-ahead" | "tamper";

/**
 * Classify the head anchor against the chain-verified `events`. Under the project
 * lock a single append writes exactly ONE record then seals, so the log can be AT
 * MOST one complete record ahead of the head — we recover ONLY that bounded case.
 */
function classifyHeadState(anchor: string | null, events: EventRecord[]): HeadState {
  const healthyExpectation = events.length === 0 ? null : eventPrevHash(events[events.length - 1]);
  if (anchor === healthyExpectation) return "healthy";
  // One-ahead: the head seals the prefix that EXCLUDES the last record.
  const sealsPrefix =
    (events.length >= 2 && anchor === eventPrevHash(events[events.length - 2])) ||
    (events.length === 1 && anchor === null);
  return sealsPrefix ? "one-ahead" : "tamper";
}

/**
 * The WRITE precondition for any append/mutation, run UNDER THE CALLER'S LOCK.
 * Unlike {@link readEventsStrict} (a READ that TOLERATES a torn trailing line), a
 * WRITE must not extend a torn tail — concatenating a new record onto a partial
 * line would produce an unparseable record and desync the head.
 *
 * Order is VERIFY-BEFORE-REPAIR. The CHAIN is strict-verified FIRST, so genuine
 * TAMPER (a broken/reordered/interior-deleted chain) throws
 * {@link EventStoreChainError} with the file left BYTE-IDENTICAL — we never
 * truncate (write to) a store we are about to reject, so a tamper-evidence failure
 * preserves the bytes for forensics. Then the head anchor is CLASSIFIED:
 *  - `healthy` → repair a torn trailing line (an UNCOMMITTED, crashed prior append)
 *    if present, else no-op;
 *  - `one-ahead` → the last record is the single UNCOMMITTED trailing record from a
 *    crash between `appendLine` and `sealHeadAnchor`. The commit point is the head
 *    SEAL, so this record is uncommitted: DROP it (truncate to the N-1 prefix the
 *    head already seals — no head rewrite needed). We TRUNCATE the uncommitted tail,
 *    NEVER keep+reseal it, so a forged un-sealed trailing record is removed, never
 *    laundered; the committed (head-sealed) prefix is never mutated.
 *  - `tamper` → genuine head/log mismatch (incl. two-ahead, head-without-log) →
 *    throw with the file BYTE-IDENTICAL.
 *
 * @param root - Absolute project root.
 * @returns The verified events (for chaining the next record's `prevHash`).
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
export async function prepareEventStoreForAppend(root: string): Promise<EventRecord[]> {
  const { events, problems } = await readEvents(root); // throws on corrupt/too-new/symlink
  // VERIFY BEFORE REPAIR: a broken/reordered chain must be rejected with the file
  // left BYTE-IDENTICAL — never truncate (write to) a store we are about to refuse.
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const state = classifyHeadState(await readHeadAnchor(root), events);
  if (state === "tamper") {
    throw new EventStoreChainError(`head anchor does not match a committable store state`);
  }
  if (state === "one-ahead") {
    // Drop the single UNCOMMITTED trailing record; the head already seals the prefix.
    const kept = events.slice(0, events.length - 1);
    await truncateToRecords(root, kept);
    return kept;
  }
  // healthy: repair only an uncommitted torn tail (no committed event is lost).
  if (hasTornTail(problems)) await truncateToRecords(root, events);
  return events;
}
