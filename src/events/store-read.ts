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
 *
 * ONE BODY for the read: {@link readEvents} runs {@link readEventsFrom} over
 * local-disk {@link EventReadSources}. The header, checksum, torn-tail, chain and
 * anchor rules, the anchor's cap and its oversize error, the trim, and "no
 * private directory or no leaf means no anchor" are decided in this file; the
 * sources only look.
 *
 * ONE BODY for the append precondition too: {@link prepareEventStoreForAppendFrom}
 * runs over local-disk {@link EventRepairSources}, which are the read sources plus ONE raw write, the
 * whole-store replacement the repair truncates through. The verify-before-repair
 * order, the head classification, the truncation bytes and the header version
 * kept are decided here; the body still reads the anchor a second time, and
 * nothing is remembered between reads.
 */

import path from "path";
import { EVENTS_FILE, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { PrivateDirConfinementError } from "../utils/private-dir.js";
import {
  diskGraphStoreReads, splitStoreRecords, type GraphStoreReads,
} from "../utils/jsonl-store.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { atomicWrite } from "../utils/markdown.js";
import type { EventRecord } from "./types.js";
import type { SegmentedEventLog } from "../history/events-segmented.js";
import { diskHeadAnchorSources, eventSymlinkError, readHeadAnchorFrom, type HeadAnchorSources } from "./head-anchor.js";
import { parseRecord, verifyChecksum, verifyEventChain } from "./record-check.js";
import {
  EVENT_STORE_BASE_WRITE_VERSION,
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreTooNewError,
  EventStoreCorruptError,
  EventStoreChainError,
} from "./types.js";
import {
  serializeEventRecord,
  eventHeaderLine,
} from "./store-record.js";
import { eventPrevHash } from "./event-digest.js";

export { verifyEventChain } from "./record-check.js";
export type { HeadLeafRead } from "./head-anchor.js";

/** The substring {@link readEvents} prefixes onto a tolerated torn-trailing-line problem. */
const TORN_TAIL_MARKER = "torn trailing line";

/** The outcome of reading the store: ordered events plus any tolerated/surfaced problems. */
export interface ReadEventsResult {
  /** Events in append (file) order. */
  events: EventRecord[];
  /** Human-readable notes (torn trailing line, chain break, head mismatch). */
  problems: string[];
}

/**
 * Everything {@link readEventsFrom} reads. OWNED BY THE EVENT READER: a narrow
 * seam with one disk implementation; not `ProjectStore`, not a hosted or
 * access-control contract, and it selects no backend. It carries NO meaning.
 * Nothing ties the graph read to the private-directory looks; production builds
 * all from one root.
 */
export interface EventReadSources extends HeadAnchorSources {
  /** The graph-store read, asked with THIS store's configuration (file name, cap and both error factories). */
  graph: GraphStoreReads;
  /**
   * OPTIONAL: the segmented event log when the project is `local-indexed`
   * (then every body here dispatches to it), or `null` when the incumbent
   * single file is the authority. Absent in test doubles: the file bodies run.
   */
  segmented?(): Promise<SegmentedEventLog | null>;
}

/**
 * LOCAL DISK. The event-read sources for the project at `root`. Building them
 * does no I/O and no path work. `graph` defaults to this root's own graph-store
 * read; a caller that already holds one for the same root may hand it in. In no
 * package index.
 */
export function diskEventReadSources(root: string, graph: GraphStoreReads = diskGraphStoreReads(root)): EventReadSources {
  return {
    graph,
    ...diskHeadAnchorSources(root),
    // Loaded on demand; the segmented log imports only the leaf validators (./record-check.ts, ./head-anchor.ts).
    segmented: () => import("../history/events-segmented.js").then((log) => log.segmentedEventLogFor(root)),
  };
}

/**
 * Everything {@link prepareEventStoreForAppendFrom} reads and writes: the read
 * sources, plus the ONE raw write its repair asks for. Owned by the event store;
 * not `ProjectStore`, not hosted, and it selects no backend.
 */
export interface EventRepairSources extends EventReadSources {
  /**
   * Replace the WHOLE store body with `body`. A reader sees the old or the new
   * body; NOT durable against power loss. REJECTS raw. Disk: the confined
   * `atomicWrite` of `<root>/wiki/graph/events.jsonl` (the root as given, not
   * resolved), confined to the root.
   */
  replaceStore(body: string): Promise<void>;
}

/**
 * LOCAL DISK. The repair sources for the project at `root`: the read sources
 * and the incumbent `atomicWrite`, reached through `../utils/markdown.js` at
 * call time. Building them does no I/O. In no package index.
 */
export function diskEventRepairSources(root: string): EventRepairSources {
  return {
    ...diskEventReadSources(root),
    replaceStore: (body) => atomicWrite(path.join(root, EVENTS_FILE), body, { confineRoot: root }),
  };
}

/** Read the raw store bytes, or null when absent — via the shared confined+capped reader. */
function readStoreFile(graph: GraphStoreReads): Promise<string | null> {
  return graph.readStore({
    fileName: path.basename(EVENTS_FILE),
    makeSymlinkError: eventSymlinkError,
    maxBytes: MAX_RELATION_STORE_BYTES,
    makeOversizeError: (size) =>
      new EventStoreCorruptError(`store file ${size} bytes exceeds the ${MAX_RELATION_STORE_BYTES}-byte cap`),
  });
}

/**
 * Read the exact raw store bytes (or null when absent) through the graph-store
 * read it is handed — the same confined, no-follow, capped read the parser uses,
 * asked with THIS store's configuration. The store-version upgrade body rewrites
 * only the header while preserving every record byte and its order. (It replaces
 * the root-taking `readEventStoreRaw`, whose only caller was that upgrade.)
 */
export function readEventStoreRawFrom(graph: GraphStoreReads): Promise<string | null> {
  return readStoreFile(graph);
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
  return verifyHeadAnchorFrom(diskEventReadSources(root), events);
}

/** {@link verifyHeadAnchor} over {@link EventReadSources}: one anchor read, then the comparison. */
async function verifyHeadAnchorFrom(
  sources: EventReadSources,
  events: EventRecord[],
): Promise<{ ok: boolean; problem?: string }> {
  const anchor = await readHeadAnchorFrom(sources);
  const expected = events.length === 0 ? null : eventPrevHash(events[events.length - 1]);
  if (anchor === expected) return { ok: true };
  return { ok: false, problem: `head anchor ${anchor ?? "<absent>"} does not match last event` };
}

/** Append chain + head-anchor problems (non-fatal) onto `problems`. */
async function appendChainProblems(sources: EventReadSources, events: EventRecord[], problems: string[]): Promise<void> {
  const chain = verifyEventChain(events);
  if (!chain.ok && chain.problem) problems.push(chain.problem);
  const anchor = await verifyHeadAnchorFrom(sources, events);
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
  return readEventsFrom(diskEventReadSources(root));
}

/**
 * {@link readEvents} over {@link EventReadSources}: THE ONE BODY. The store is
 * asked first; then the anchor is ALWAYS asked, for an absent or header-only
 * store too. Nothing is caught, so a rejection leaves as the same error.
 */
export async function readEventsFrom(sources: EventReadSources): Promise<ReadEventsResult> {
  const segmented = await sources.segmented?.();
  if (segmented) return segmented.readAll(); // capped compatibility materializer of the indexed log
  const raw = await readStoreFile(sources.graph); // throws on symlink/too-new/corrupt
  const recordLines = splitStoreRecords(raw, parseHeader);
  // An ABSENT or header-only log yields ZERO events — but if the sealed head
  // anchor still points at a real digest, a prior log was TRUNCATED to empty
  // (not a fresh project). Run the head-anchor check on the empty list so that
  // truncation surfaces as a head-mismatch problem instead of a healthy empty.
  if (recordLines === null) {
    const emptyProblems: string[] = [];
    await appendChainProblems(sources, [], emptyProblems);
    return { events: [], problems: emptyProblems };
  }
  const problems: string[] = [];
  const events = parseRecords(recordLines, problems);
  await appendChainProblems(sources, events, problems);
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
 * @param sources - The read sources (for the head-anchor read).
 * @param events - Events in append order.
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
async function verifyChainAndHeadFrom(sources: EventReadSources, events: EventRecord[]): Promise<void> {
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const anchor = await verifyHeadAnchorFrom(sources, events);
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
  return readEventsStrictFrom(diskEventReadSources(root));
}

/**
 * {@link readEventsStrict} over {@link EventReadSources}: THE ONE BODY. The whole
 * read first ({@link readEventsFrom}: the store, then the anchor), then the strict
 * verification: the chain, then a SECOND, fresh head-anchor read. Every error
 * leaves unchanged; a torn trailing line alone is tolerated.
 */
export async function readEventsStrictFrom(sources: EventReadSources): Promise<EventRecord[]> {
  const { events } = await readEventsFrom(sources);
  await verifyChainAndHeadFrom(sources, events);
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
 * The header version is read through the sources' graph read FIRST, then the
 * body is handed to their one whole-store replacement.
 */
async function truncateToRecordsFrom(sources: EventRepairSources, kept: EventRecord[]): Promise<void> {
  const version = await currentEventHeaderVersionFrom(sources.graph);
  const body = eventHeaderLine(version) + kept.map((e) => serializeEventRecord(stripChecksum(e))).join("");
  await sources.replaceStore(body);
}

/**
 * The store's current declared header version, so a torn-tail/one-ahead repair
 * preserves it (a v2 store carrying operation-bound records is never downgraded
 * to v1). An absent or malformed header defaults to the ordinary base version.
 */
async function currentEventHeaderVersionFrom(graph: GraphStoreReads): Promise<number> {
  const raw = await readStoreFile(graph);
  if (raw === null) return EVENT_STORE_BASE_WRITE_VERSION;
  const split = splitStoreHeaderLine(raw);
  const version = split === null ? null : parseStoreHeaderVersion(split.headerLine, "event-store-header");
  return version ?? EVENT_STORE_BASE_WRITE_VERSION;
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
 * THE ONE BODY, over {@link EventRepairSources} (locally `diskEventRepairSources(root)`,
 * which the event store's own write sources spread). The whole read (store, then
 * anchor), the strict chain check, a SECOND
 * anchor read for the classification, then at most one truncation. A refusal
 * writes nothing; nothing is caught, so every rejection leaves as the same error.
 *
 * @param sources - The read sources plus the whole-store replacement.
 * @returns The verified events (for chaining the next record's `prevHash`).
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
export async function prepareEventStoreForAppendFrom(sources: EventRepairSources): Promise<EventRecord[]> {
  const segmented = await sources.segmented?.();
  if (segmented) {
    await segmented.verifyForAppend(); // bounded: the committed tail, the anchor, the legacy backup
    return [];
  }
  const { events, problems } = await readEventsFrom(sources); // throws on corrupt/too-new/symlink
  // VERIFY BEFORE REPAIR: a broken/reordered chain must be rejected with the file
  // left BYTE-IDENTICAL — never truncate (write to) a store we are about to refuse.
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const state = classifyHeadState(await readHeadAnchorFrom(sources), events);
  if (state === "tamper") {
    throw new EventStoreChainError(`head anchor does not match a committable store state`);
  }
  if (state === "one-ahead") {
    // Drop the single UNCOMMITTED trailing record; the head already seals the prefix.
    const kept = events.slice(0, events.length - 1);
    await truncateToRecordsFrom(sources, kept);
    return kept;
  }
  // healthy: repair only an uncommitted torn tail (no committed event is lost).
  if (hasTornTail(problems)) await truncateToRecordsFrom(sources, events);
  return events;
}
