/**
 * @file src/events/types.ts
 * @description Type surface for the append-only, HASH-CHAINED EVENT STORE
 * (CLP 4b) — the tamper-evident audit log at `wiki/graph/events.jsonl`.
 *
 * Every lifecycle transition and relation write emits one {@link EventRecord}.
 * Each record carries a `prevHash` linking it to the digest of the PRIOR record
 * (the first record's `prevHash` is the fixed {@link GENESIS_PREV_HASH}), so the
 * records form a chain: editing, reordering, or deleting any record breaks the
 * link from its successor. A separate per-record `checksum` (sha256 of the
 * record-without-checksum form) detects a single flipped byte independently of
 * the chain — the SAME defense-in-depth split the relation store uses.
 *
 * On disk the first line of a non-empty store is an {@link EventStoreHeader}
 * carrying `schemaVersion`; readers FAIL CLOSED when it exceeds
 * {@link EVENT_STORE_SCHEMA_VERSION}. A sealed HEAD anchor (the digest of the
 * last event, at `.llmwiki/events.head`) lets a reader detect a TRUNCATED or
 * wholesale-rewritten log: the last record's digest must equal the anchor.
 *
 * DURABILITY: emit is best-effort AFTER the durable mutation, so a crash between
 * the mutation and the append leaves a missing trailing event — the torn-trailing
 * case the reader tolerates and reports. An interior tear / bad checksum / chain
 * break is fail-closed (corrupt) or surfaced (chain) per the read contract.
 */

/** The event-store JSONL schema version readers understand. */
export const EVENT_STORE_SCHEMA_VERSION = 1;

/**
 * The fixed `prevHash` of the FIRST event in a store — the chain's genesis
 * anchor. A constant (not a real digest) so the first record's link is
 * unambiguous and a reader can assert `events[0].prevHash === GENESIS_PREV_HASH`.
 */
export const GENESIS_PREV_HASH = "genesis";

/** The kinds of mutation that emit an audit event. */
export type EventType = "lifecycle-transition" | "relation-create" | "relation-update";

/** An event id, always of the form `evt_<ULID>`. */
export type EventId = `evt_${string}`;

/** The content fields an event's chain digest is computed over (excludes prevHash/checksum). */
export interface EventContent {
  /** Stable handle, allocated once at emit. */
  id: EventId;
  /** Which mutation produced this event. */
  type: EventType;
  /** Where the mutation originated (e.g. `"sdk"`). */
  origin: string;
  /** Optional acting principal (user/agent), when known. */
  actor?: string;
  /** Mutation-specific detail (entity/slug/from/to/state etc.). */
  payload: Record<string, unknown>;
  /** Optional trust decision that routed the mutation. */
  decision?: string;
  /** ISO-8601 emit timestamp. */
  at: string;
}

/**
 * One audit event. `prevHash` links to the digest of the prior record (or
 * {@link GENESIS_PREV_HASH} for the first); `checksum` is the per-record
 * integrity hash. See the file overview for the full chain contract.
 */
export interface EventRecord extends EventContent {
  /** Digest of the PRIOR record (genesis anchor for the first). */
  prevHash: string;
  /** sha256 of the canonical record-without-checksum (incl. prevHash). */
  checksum: string;
}

/** The first line of a non-empty store, carrying its schema version. */
export interface EventStoreHeader {
  /** Discriminator marking this line as the header, not a record. */
  kind: "event-store-header";
  /** The store schema version; readers fail closed when it exceeds known. */
  schemaVersion: number;
}

/** Raised when a store's `schemaVersion` exceeds the known version (fail closed). */
export class EventStoreTooNewError extends Error {
  constructor(found: number, known: number) {
    super(`event store schemaVersion ${found} exceeds supported ${known}`);
    this.name = "EventStoreTooNewError";
  }
}

/** Raised when interior store content is corrupt (bad checksum / malformed line). */
export class EventStoreCorruptError extends Error {
  constructor(message: string) {
    super(`event store corrupt: ${message}`);
    this.name = "EventStoreCorruptError";
  }
}

/**
 * Raised when the canonical store FILE leaf (`wiki/graph/events.jsonl`) is a
 * SYMLINK or non-regular file. The no-follow open fails closed here, so an event
 * append can never land outside the project root and a read can never return
 * out-of-tree bytes — the LEAF defense complementing the graph-DIR confinement.
 */
export class EventStoreSymlinkError extends Error {
  constructor(message: string) {
    super(`event store file leaf rejected: ${message}`);
    this.name = "EventStoreSymlinkError";
  }
}

/**
 * Raised when the hash chain is broken, forked, reordered, or its sealed HEAD
 * anchor does not match the last event — tamper evidence. Callers that demand an
 * intact chain throw this; {@link readEvents} instead surfaces it as a `problem`
 * so a later lint/status surface can report it without failing the read.
 */
export class EventStoreChainError extends Error {
  constructor(message: string) {
    super(`event store chain broken: ${message}`);
    this.name = "EventStoreChainError";
  }
}

/**
 * Raised when an append would drive the event store to/over
 * {@link MAX_EVENT_STORE_BYTES} (the SAME bound the reader fails closed at), or
 * when a single record's serialized size exceeds {@link MAX_EVENT_RECORD_BYTES}.
 * The append path fails closed BEFORE writing so the store can never be grown
 * past the read cap into an unreadable-yet-appendable (bricked) state.
 *
 * NOTE: rotation/archival of an exhausted event log is a documented future item —
 * no automatic rotation is performed; callers must handle this error explicitly.
 */
export class EventStoreFullError extends Error {
  constructor() {
    super("event store is full; rotation/archival is required");
    this.name = "EventStoreFullError";
  }
}
