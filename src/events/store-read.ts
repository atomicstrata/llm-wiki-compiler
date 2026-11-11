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
 * kept are decided here; the head classification judges the anchor the whole
 * read took, and nothing is remembered between calls.
 */

import path from "path";
import { EVENTS_FILE, EVENTS_HEAD_FILE, MAX_RELATION_STORE_BYTES, MAX_EVENT_HEAD_BYTES } from "../utils/constants.js";
import { resolveExistingConfinedPrivateDir, PrivateDirConfinementError } from "../utils/private-dir.js";
import {
  diskGraphStoreReads, openGraphFileRead, splitStoreRecords, type GraphStoreReads, type SymlinkErrorFactory,
} from "../utils/jsonl-store.js";
import { readOpenedTextWithinCap } from "../utils/no-follow-open.js";
import { isOperationBinding } from "../utils/operation-binding.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { atomicWrite } from "../utils/markdown.js";
import type { EventRecord } from "./types.js";
import {
  EVENT_STORE_BASE_WRITE_VERSION,
  EVENT_STORE_SCHEMA_VERSION,
  GENESIS_PREV_HASH,
  EventStoreTooNewError,
  EventStoreCorruptError,
  EventStoreSymlinkError,
  EventStoreChainError,
} from "./types.js";
import {
  eventChecksum,
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

/** What one look at the head-anchor leaf found: nothing there, a leaf over the cap (never read), or its text. */
export type HeadLeafRead =
  | { kind: "absent" }
  | { kind: "oversize"; size: number }
  | { kind: "text"; text: string };

/**
 * Everything {@link readEventsFrom} reads. OWNED BY THE EVENT READER: a narrow
 * seam with one disk implementation; not `ProjectStore`, not a hosted or
 * access-control contract, and it selects no backend. It carries NO meaning.
 * Nothing ties the graph read to the private-directory looks; production builds
 * all from one root.
 */
export interface EventReadSources {
  /** The graph-store read, asked with THIS store's configuration (file name, cap and both error factories). */
  graph: GraphStoreReads;
  /** The existing private directory, resolved WITHOUT creating it, or `null` when there is none. REJECTS on a confinement fault and on any other failure. */
  resolvePrivateDir(): Promise<string | null>;
  /**
   * One leaf of a resolved private directory, opened WITHOUT following a link.
   * A link or a non-regular leaf REJECTS with what `makeSymlinkError` builds; a
   * leaf over `maxBytes` is a value carrying its size and is never read; a
   * failed read or close REJECTS raw.
   */
  readHeadLeaf(dir: string, name: string, maxBytes: number, makeSymlinkError: SymlinkErrorFactory): Promise<HeadLeafRead>;
}

/** The event store's typed link error, built here for the graph read and for the head-anchor leaf alike. */
function eventSymlinkError(reason: string): Error {
  return new EventStoreSymlinkError(reason);
}

/**
 * LOCAL DISK. The head-anchor leaf look: the no-follow open (a link or a
 * non-regular leaf fails closed), the size look, the read only when within the
 * cap, and the close in `finally`, in that order. A close that fails wins over
 * whatever the look had found, as it always did.
 */
async function readDiskHeadLeaf(file: string, maxBytes: number, makeSymlinkError: SymlinkErrorFactory): Promise<HeadLeafRead> {
  const handle = await openGraphFileRead(file, makeSymlinkError);
  if (handle === null) return { kind: "absent" };
  return readOpenedTextWithinCap(handle, maxBytes);
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
    resolvePrivateDir: () => resolveExistingConfinedPrivateDir(root),
    readHeadLeaf: (dir, name, maxBytes, makeSymlinkError) => readDiskHeadLeaf(path.join(dir, name), maxBytes, makeSymlinkError),
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
  if (rec.operationBinding !== undefined && !isOperationBinding(rec.operationBinding)) {
    throw new EventStoreCorruptError(`event ${rec.id} has a malformed operation binding`);
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

/**
 * Read the sealed head-anchor digest, or null when it is absent, over
 * {@link EventReadSources}: THE ONE BODY. No private
 * directory and no leaf each mean no anchor; a leaf over the cap is this store's
 * corrupt error and was never read; the text is trimmed here.
 */
async function readHeadAnchorFrom(sources: EventReadSources): Promise<string | null> {
  const dir = await sources.resolvePrivateDir(); // throws on .llmwiki symlink escape
  if (dir === null) return null; // absent .llmwiki → no head anchor, clean project
  const read = await sources.readHeadLeaf(dir, path.basename(EVENTS_HEAD_FILE), MAX_EVENT_HEAD_BYTES, eventSymlinkError);
  if (read.kind === "absent") return null;
  if (read.kind === "oversize") {
    throw new EventStoreCorruptError(
      `head anchor file ${read.size} bytes exceeds the ${MAX_EVENT_HEAD_BYTES}-byte cap`,
    );
  }
  return read.text.trim();
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
  return compareHeadAnchor(await readHeadAnchorFrom(sources), events);
}

/** Whether the anchor read seals the last of `events` (or is absent over none). Pure. */
function compareHeadAnchor(anchor: string | null, events: EventRecord[]): { ok: boolean; problem?: string } {
  const expected = events.length === 0 ? null : eventPrevHash(events[events.length - 1]);
  if (anchor === expected) return { ok: true };
  return { ok: false, problem: `head anchor ${anchor ?? "<absent>"} does not match last event` };
}

/** Append chain + head-anchor problems (non-fatal) onto `problems`. */
function appendChainProblems(anchor: string | null, events: EventRecord[], problems: string[]): void {
  const chain = verifyEventChain(events);
  if (!chain.ok && chain.problem) problems.push(chain.problem);
  const verdict = compareHeadAnchor(anchor, events);
  if (!verdict.ok && verdict.problem) problems.push(verdict.problem);
}

/** A whole read, with the one head-anchor read its problems were judged against. */
interface AnchoredEventsRead extends ReadEventsResult {
  anchor: string | null;
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
  const { events, problems } = await readAnchoredEventsFrom(sources);
  return { events, problems };
}

/**
 * {@link readEventsFrom}, also answering the head anchor it read. The strict
 * read and the append precondition judge THAT anchor: reading it a second time
 * straight after would only ask the same leaf the same question (under the
 * append's lock nothing can seal between the two; outside it, a seal landing
 * between them would pit a newer anchor against the older events read here).
 */
async function readAnchoredEventsFrom(sources: EventReadSources): Promise<AnchoredEventsRead> {
  const raw = await readStoreFile(sources.graph); // throws on symlink/too-new/corrupt
  const recordLines = splitStoreRecords(raw, parseHeader);
  // An ABSENT or header-only log yields ZERO events — but if the sealed head
  // anchor still points at a real digest, a prior log was TRUNCATED to empty
  // (not a fresh project). Run the head-anchor check on the empty list so that
  // truncation surfaces as a head-mismatch problem instead of a healthy empty.
  const problems: string[] = [];
  const events = recordLines === null ? [] : parseRecords(recordLines, problems);
  const anchor = await readHeadAnchorFrom(sources);
  appendChainProblems(anchor, events, problems);
  return { events, problems, anchor };
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
function verifyChainAndHead(anchor: string | null, events: EventRecord[]): void {
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const verdict = compareHeadAnchor(anchor, events);
  if (!verdict.ok) throw new EventStoreChainError(verdict.problem ?? "head anchor mismatch");
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
 * verification: the chain, then that read's head anchor. Every error
 * leaves unchanged; a torn trailing line alone is tolerated.
 */
export async function readEventsStrictFrom(sources: EventReadSources): Promise<EventRecord[]> {
  const { events, anchor } = await readAnchoredEventsFrom(sources);
  verifyChainAndHead(anchor, events);
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
 * anchor), the strict chain check, the classification of that read's anchor,
 * then at most one truncation. A refusal
 * writes nothing; nothing is caught, so every rejection leaves as the same error.
 *
 * @param sources - The read sources plus the whole-store replacement.
 * @returns The verified events (for chaining the next record's `prevHash`).
 * @throws {EventStoreChainError} When the chain is broken or the head anchor mismatches.
 */
export async function prepareEventStoreForAppendFrom(sources: EventRepairSources): Promise<EventRecord[]> {
  const { events, problems, anchor } = await readAnchoredEventsFrom(sources); // throws on corrupt/too-new/symlink
  // VERIFY BEFORE REPAIR: a broken/reordered chain must be rejected with the file
  // left BYTE-IDENTICAL — never truncate (write to) a store we are about to refuse.
  const chain = verifyEventChain(events);
  if (!chain.ok) throw new EventStoreChainError(chain.problem ?? "chain verification failed");
  const state = classifyHeadState(anchor, events);
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
