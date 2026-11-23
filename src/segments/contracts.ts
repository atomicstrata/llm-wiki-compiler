/**
 * @file src/segments/contracts.ts
 * @description The names of the durable local SEGMENT STORE: immutable,
 * bounded, digest-addressed segment files grouped into sorted runs, and one
 * small manifest per store that is that store's single publication fence.
 *
 * A store is a sequence of RUNS, oldest first. Within a run the segments are
 * sorted and their key ranges do not overlap; runs may overlap one another,
 * and a NEWER run's row for a key wins over an older one. A tombstone row
 * (`d: 1`) hides every older row for its key.
 *
 * Nothing in a segment is ever rewritten. A commit writes new segment files
 * create-only and durably, then replaces the manifest atomically and durably,
 * after comparing the manifest it planned against with the one on disk. Old
 * segments, merged inputs and orphans of a crashed commit are RETAINED: this
 * build performs no garbage collection and no destructive cleanup, so retained
 * bytes grow and are reported.
 */

/** One stored row. Keys compare by UTF-16 code unit (`<`), never by locale. */
export interface SegmentRow {
  readonly k: string;
  /** The row's JSON value; absent on a tombstone. */
  readonly v?: unknown;
  /** Present (and 1) exactly on a tombstone. */
  readonly d?: 1;
}

/** One immutable segment file as the manifest records it. */
export interface SegmentEntry {
  readonly name: string;
  readonly minKey: string;
  readonly maxKey: string;
  readonly rows: number;
  /** Exact file length. */
  readonly bytes: number;
  /** SHA-256 of the whole file; checked by full verification. */
  readonly sha256: string;
  /** SHA-256 of the segment's block index; checked on every open. */
  readonly indexSha256: string;
}

/** One sorted run: non-overlapping segments in key order. */
export interface RunEntry {
  readonly id: number;
  readonly rows: number;
  readonly segments: readonly SegmentEntry[];
}

/** The manifest: the store's only publication point. */
export interface SegmentManifest {
  readonly format: "llmwiki-segments";
  readonly version: 1;
  readonly store: string;
  /** Moves by one on every publication. Diagnostic only: publication compares exact manifest bytes. */
  readonly generation: number;
  readonly nextRunId: number;
  /** Oldest first. */
  readonly runs: readonly RunEntry[];
  /** Store-specific facts, validated by the store that owns them. */
  readonly meta: Readonly<Record<string, unknown>>;
}

/** Store names: a short lowercase identifier, also the store's directory name. */
export const STORE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The private directory every store lives under, relative to the project root. */
export const INDEXED_DIR = ".llmwiki/indexed";

/** Most entries complete indexed run discovery and maintenance inventory list. */
export const MAX_INDEXED_STORE_ENTRIES = 10_000;

/** The manifest leaf of every store. */
export const MANIFEST_LEAF = "manifest.json";

/** A manifest larger than this is unreadable. */
export const MAX_SEGMENT_MANIFEST_BYTES = 1024 * 1024;

/** Largest single row, serialized. */
export const MAX_ROW_BYTES = 1024 * 1024;

/** Longest key, in UTF-16 code units. */
export const MAX_KEY_CHARS = 512;

/** A block is read and verified whole; rows never span blocks. */
export const BLOCK_TARGET_BYTES = 64 * 1024;

/** Largest block: a block exceeds the target only when it holds one row larger than the target. */
export const MAX_BLOCK_BYTES = Math.max(BLOCK_TARGET_BYTES, MAX_ROW_BYTES);

/** Largest block index (footer) of one segment. */
export const MAX_FOOTER_BYTES = 4 * 1024 * 1024;

/** Rows per segment, at most. */
export const MAX_SEGMENT_ROWS = 4096;

/** Default byte budget of one segment (a store may choose another, at most {@link MAX_SEGMENT_BYTES}). */
export const DEFAULT_SEGMENT_BYTES = 1024 * 1024;

/** Largest per-segment row-data budget a store may choose. */
export const MAX_SEGMENT_DATA_BYTES = 8 * 1024 * 1024;

/** Hard ceiling on one segment file, footer and trailer included. */
export const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

/** Runs of the same size tier that trigger a merge of the newest ones. */
export const MERGE_FANOUT = 8;

/** More runs than this force a merge of the smallest adjacent pair. */
export const MAX_RUNS = 48;

/**
 * Why a store operation failed. Every code except `indexed_store_outcome_unknown`
 * leaves the published manifest exactly as it was. `indexed_store_outcome_unknown`
 * means the manifest replacement may have taken effect (the writer failed after
 * its rename, or the result could not be re-read): the caller must reopen the
 * store and reconcile against what is actually published, never blindly retry
 * a non-idempotent change. `indexed_reader_lease_unavailable` refuses a read
 * whose process could not register itself as a reader (`./reader-lease.ts`),
 * or that would open a snapshot while this process collects the store.
 * `indexed_restore_in_progress` and `indexed_restore_incomplete` refuse
 * anything outside a running or interrupted indexed-authority restore
 * (`./restore-marker.ts`). `indexed_retirement_in_progress` refuses a read
 * while a batch run retirement whose owner may be running holds its barrier
 * (`./retire-barrier.ts`).
 */
export type IndexedStoreErrorCode =
  | "indexed_store_corrupt"
  | "indexed_store_unavailable"
  | "indexed_store_concurrent_change"
  | "indexed_store_invalid_write"
  | "indexed_store_outcome_unknown"
  | "indexed_reader_lease_unavailable"
  | "indexed_restore_in_progress"
  | "indexed_restore_incomplete"
  | "indexed_retirement_in_progress";

/** A typed store failure; callers branch on `code`. */
export class IndexedStoreError extends Error {
  constructor(readonly code: IndexedStoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IndexedStoreError";
  }
}

/** Throw an invalid-write refusal: nothing was published. */
export function invalidWrite(message: string): never {
  throw new IndexedStoreError("indexed_store_invalid_write", message);
}

/** Throw a corruption refusal; nothing falls back to another copy. */
export function corrupt(message: string): never {
  throw new IndexedStoreError("indexed_store_corrupt", message);
}

/** Sort rows by key (code-unit order), as one run's commit requires. */
export function sortedByKey(rows: SegmentRow[]): SegmentRow[] {
  return rows.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
}
