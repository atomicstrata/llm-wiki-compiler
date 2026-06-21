/**
 * @file src/relations/types.ts
 * @description Type surface for the typed RELATION STORE (Phase 4) — the
 * append-only JSONL graph at `wiki/graph/relations.jsonl`.
 *
 * A {@link RelationRef} is one typed edge between two entity pages. Its `id`
 * (`rel_<ULID>`) is allocated ONCE at creation and is NEVER derived from or
 * recomputed against content — it is the stable handle a later update
 * references. Its `contentHash` is the canonical RFC 8785 digest over
 * `{type, from, to, attributes, evidence}` and IS recomputed whenever
 * `attributes`/`evidence` change; it is the DEDUP KEY — an append whose
 * `contentHash` matches a live relation is an idempotent no-op (see
 * `appendRelationLocked`). It is NOT yet an optimistic-concurrency precondition;
 * a `preconditionHash`-style check is reserved for future staged-relation edits.
 * Changing `type`/`from`/`to` is a delete+create (a different edge), not an
 * in-place update.
 *
 * On disk each line is a {@link RelationRecord}: the `RelationRef` plus a
 * per-record `checksum` (sha256 of the canonical record-without-checksum form).
 * The first line of a non-empty store is a {@link RelationStoreHeader} carrying
 * the store `schemaVersion`. Readers FAIL CLOSED when that version exceeds
 * {@link RELATION_STORE_SCHEMA_VERSION}.
 *
 * DURABILITY: a torn TRAILING line is tolerated on a clean process crash and
 * reported. There is NO fsync, so power-loss durability is NOT provided; an
 * interior tear (any malformed/bad-checksum line before the last) fails the
 * store closed.
 */

import type { EntityId } from "../profile/types.js";

/** The relation-store JSONL schema version readers understand. */
export const RELATION_STORE_SCHEMA_VERSION = 1;

/**
 * A minimal citation backing a relation: the source file the claim came from
 * and an optional span within it (line range / char offset, free-form). The
 * exact span grammar is deferred; the contract here is only that it is a
 * stable string so it participates deterministically in the content hash.
 */
export interface CitationRef {
  /** Project-relative path of the source the relation is evidenced by. */
  sourcePath: string;
  /** Optional span within the source (free-form, e.g. `"L10-L14"`). */
  sourceSpan?: string;
}

/** A relation id, always of the form `rel_<ULID>`. */
export type RelationId = `rel_${string}`;

/**
 * One typed edge between two entity pages.
 *
 * `id` is minted once and never recomputed; `contentHash` is the canonical
 * digest of the content fields (the DEDUP KEY), recomputed on every
 * attribute/evidence update. See the file overview for the full contract.
 */
export interface RelationRef {
  /** Stable handle, allocated once at creation. */
  id: RelationId;
  /** Relation-type id, a key of `profile.relations`. */
  type: string;
  /** The `from` endpoint entity page id (`<entityType>/<slug>`). */
  from: EntityId;
  /** The `to` endpoint entity page id. */
  to: EntityId;
  /** Typed relation attributes (validated against the relation-type def). */
  attributes: Record<string, unknown>;
  /** Optional citations backing the relation. */
  evidence?: CitationRef[];
  /** Canonical digest over `{type, from, to, attributes, evidence}`. */
  contentHash: string;
}

/**
 * The on-disk JSONL line shape: a {@link RelationRef} plus the per-record
 * `checksum` recomputed and compared on read. The checksum covers the record's
 * content (the `RelationRef` fields) so a flipped byte anywhere is detected.
 */
export interface RelationRecord extends RelationRef {
  /** sha256 of the canonical record (all fields except `checksum`). */
  checksum: string;
}

/** The first line of a non-empty store, carrying its schema version. */
export interface RelationStoreHeader {
  /** Discriminator marking this line as the header, not a record. */
  kind: "relation-store-header";
  /** The store schema version; readers fail closed when it exceeds known. */
  schemaVersion: number;
}

/** The content fields a {@link RelationRef}'s `contentHash` is computed over. */
export interface RelationContentInput {
  type: string;
  from: EntityId;
  to: EntityId;
  attributes: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** Raised when a store's `schemaVersion` exceeds the known version (fail closed). */
export class RelationStoreTooNewError extends Error {
  constructor(found: number, known: number) {
    super(`relation store schemaVersion ${found} exceeds supported ${known}`);
    this.name = "RelationStoreTooNewError";
  }
}

/** Raised when interior store content is corrupt (bad checksum / malformed line). */
export class RelationStoreCorruptError extends Error {
  constructor(message: string) {
    super(`relation store corrupt: ${message}`);
    this.name = "RelationStoreCorruptError";
  }
}

/** Raised when a relation's endpoints/attributes violate the relation-type def. */
export class RelationEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationEndpointError";
  }
}

/**
 * Raised when an append would drive the store to/over
 * {@link MAX_RELATION_STORE_BYTES} — the SAME bound the reader fails closed at.
 * The append path fails closed BEFORE writing so the store can never be grown
 * past the read cap into an unreadable-yet-appendable (bricked) state; the
 * escape valve is {@link compactRelations}.
 */
export class RelationStoreFullError extends Error {
  constructor() {
    super("relation store is full; run compaction");
    this.name = "RelationStoreFullError";
  }
}
