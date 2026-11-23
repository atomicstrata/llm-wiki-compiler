/**
 * @file src/segments/store.ts
 * @description One durable segment store: open, point lookup, bounded range
 * scan, conditional commit and full verification.
 *
 * READ. {@link SegmentStore.open} reads the manifest once (absent means an
 * empty store). A lookup consults runs newest first and reads at most one
 * block index and one block per run whose key range covers the key. A scan
 * merges the runs newest-wins and reads one block per run at a time, so its
 * resident rows are bounded by the run count, never by the store size.
 *
 * COMMIT. Writers hold the shared gated project lock. A commit first compares
 * the manifest on disk with the exact bytes this snapshot was read from, then
 * writes the new run and any merges create-only and durably, then publishes
 * the next manifest. At the atomic writer's last pre-publication seam the
 * manifest is read AGAIN and must still be byte-identical, or the commit
 * throws `indexed_store_concurrent_change` and publishes nothing. A generation
 * number alone is never treated as the condition. Segments written by a
 * failed commit stay as unreferenced orphans; nothing is deleted.
 */

import { AtomicWritePostCommitError } from "../utils/atomic-write.js";
import {
  IndexedStoreError, DEFAULT_SEGMENT_BYTES, MAX_SEGMENT_DATA_BYTES, type RunEntry, type SegmentManifest, type SegmentRow,
} from "./contracts.js";
import { ambientCounters, type IoCounters } from "./counters.js";
import { compactRuns } from "./compaction.js";
import type { SegmentStoreIo } from "./io.js";
import { emptyManifest, parseManifest, serializeManifest } from "./manifest.js";
import { mergeRuns } from "./merge.js";
import { runLookup, runRows, type RangeStart } from "./reader.js";
import { writeRun } from "./run-writer.js";

/** Options of an opened store. */
export interface StoreOptions {
  /** Per-segment byte budget for this store's writes. */
  readonly segmentBytes?: number;
  readonly counters?: IoCounters;
}

/** A bounded range scan. */
export interface ScanOptions extends RangeStart {
  /** Only keys beginning with this prefix; the scan stops at the first key past it. */
  readonly prefix?: string;
}

/** What a commit publishes. */
export interface CommitInput {
  /** New rows (puts and tombstones), strictly ascending; may be empty when only `meta` changes. */
  readonly rows?: AsyncIterable<SegmentRow> | Iterable<SegmentRow>;
  /** The complete next `meta`; the current one is kept when omitted. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** Whether two manifest snapshots are the same bytes (or both absent). */
function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

/** The full key range of a run. */
function runCovers(run: RunEntry, key: string): boolean {
  return run.segments[0]!.minKey <= key && key <= run.segments.at(-1)!.maxKey;
}

/** One opened snapshot of a store. Immutable: a commit returns the next snapshot. */
export class SegmentStore {
  private constructor(
    readonly io: SegmentStoreIo,
    readonly manifest: SegmentManifest,
    private readonly bytes: Buffer | null,
    private readonly segmentBytes: number,
    readonly counters: IoCounters,
  ) {}

  /** Read the manifest of `io`'s store once. An unreadable manifest rejects; it is never treated as empty. */
  static async open(io: SegmentStoreIo, options: StoreOptions = {}): Promise<SegmentStore> {
    const counters = options.counters ?? ambientCounters();
    const segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    if (!(segmentBytes > 0 && segmentBytes <= MAX_SEGMENT_DATA_BYTES)) throw new IndexedStoreError("indexed_store_invalid_write", "segment byte budget out of range");
    const read = await io.readManifest();
    counters.manifestReads += 1;
    if (read.kind === "ok") counters.manifestBytesRead += read.bytes.byteLength;
    if (read.kind === "absent") return new SegmentStore(io, emptyManifest(io.store), null, segmentBytes, counters);
    return new SegmentStore(io, parseManifest(read.bytes, io.store), read.bytes, segmentBytes, counters);
  }

  /**
   * This same snapshot (manifest, bytes, counters) read through `io` instead:
   * how a full verification routes its reads through a verification-scoped
   * cache (`./verification-cache.ts`). Never used to publish.
   */
  withIo(io: SegmentStoreIo): SegmentStore {
    return new SegmentStore(io, this.manifest, this.bytes, this.segmentBytes, this.counters);
  }

  /** Whether a manifest has ever been published. */
  get exists(): boolean {
    return this.bytes !== null;
  }

  /** The store-specific facts of this snapshot. */
  get meta(): Readonly<Record<string, unknown>> {
    return this.manifest.meta;
  }

  /** Total rows across runs, counting superseded versions and tombstones (an upper bound on live rows). */
  get storedRows(): number {
    return this.manifest.runs.reduce((sum, run) => sum + run.rows, 0);
  }

  /** The live value at `key`, or `undefined`. Newest run first; a tombstone hides older rows. */
  async get(key: string): Promise<unknown> {
    for (let at = this.manifest.runs.length - 1; at >= 0; at -= 1) {
      const run = this.manifest.runs[at]!;
      if (!runCovers(run, key)) continue;
      const row = await runLookup(this.io, run, key, this.counters);
      if (row !== undefined) return row.d === 1 ? undefined : row.v;
    }
    return undefined;
  }

  /** Live rows in ascending key order from `options`, merged newest-wins, one block per run resident. */
  async *scan(options: ScanOptions = {}): AsyncGenerator<SegmentRow> {
    const prefix = options.prefix ?? "";
    const from = options.from !== undefined && options.from > prefix ? options.from : prefix;
    const start: RangeStart = { from, ...(options.after === undefined ? {} : { after: options.after }) };
    const inputs = this.manifest.runs.map((run) => runRows(this.io, run, start, this.counters));
    for await (const row of mergeRuns(inputs, false)) {
      if (!row.k.startsWith(prefix)) return;
      yield row;
    }
  }

  /** Publish `input` conditionally; returns the next snapshot. */
  async commit(input: CommitInput): Promise<SegmentStore> {
    await this.assertUnchanged();
    const context = { target: { io: this.io, segmentBytes: this.segmentBytes, counters: this.counters }, nextRunId: this.manifest.nextRunId };
    const added = input.rows === undefined ? null : await writeRun({ ...context.target, runId: context.nextRunId++ }, input.rows);
    const runs = await compactRuns(context, added === null ? this.manifest.runs : [...this.manifest.runs, added]);
    const next: SegmentManifest = {
      ...this.manifest, generation: this.manifest.generation + 1, nextRunId: context.nextRunId, runs, meta: input.meta ?? this.manifest.meta,
    };
    const bytes = serializeManifest(next);
    await this.publish(bytes);
    return new SegmentStore(this.io, next, bytes, this.segmentBytes, this.counters);
  }

  /**
   * Publish `bytes` conditionally. A refusal at the seam is `concurrent_change`
   * (nothing published). A failure AFTER the rename (`AtomicWritePostCommitError`)
   * is always `indexed_store_outcome_unknown`, whatever a re-read shows. Any
   * other failure is reconciled against the disk: if the new manifest is what
   * is now published or the disk cannot be re-read, the outcome is unknown
   * and the caller must reopen; otherwise the original error propagates and
   * nothing was published.
   */
  private async publish(bytes: Buffer): Promise<void> {
    try {
      await this.io.publishManifest(bytes, () => this.assertUnchanged());
    } catch (error) {
      if (error instanceof IndexedStoreError && error.code === "indexed_store_concurrent_change") throw error;
      const detail = await this.unknownOutcome(error, bytes);
      if (detail === null) throw error;
      throw new IndexedStoreError("indexed_store_outcome_unknown", `store ${this.io.store}: ${detail}; reopen and reconcile (${error instanceof Error ? error.message : String(error)})`);
    }
    this.counters.manifestsPublished += 1;
  }

  /**
   * Why a failed publication of `bytes` may have published (its outcome is
   * unknown), or `null` when the re-read proves nothing was published by it:
   * the disk cannot be re-read, the new bytes are now published, or the
   * failure came after the rename.
   */
  private async unknownOutcome(error: unknown, bytes: Buffer): Promise<string | null> {
    const now = await this.io.readManifest().catch(() => null);
    if (now === null) return "the published manifest could not be re-read";
    if (now.kind === "ok" && now.bytes.equals(bytes)) return "the new manifest is published but its durability was not confirmed";
    return error instanceof AtomicWritePostCommitError ? "the publication failed after its rename and the manifest on disk is not the new one" : null;
  }

  /**
   * Refuse with `indexed_store_concurrent_change` unless the published
   * manifest is still exactly this snapshot's: the final check of a path that
   * answers from the snapshot WITHOUT publishing (an idempotent replay).
   */
  assertCurrent(): Promise<void> {
    return this.assertUnchanged();
  }

  /** Refuse unless the manifest on disk is still exactly the one this snapshot was read from. */
  private async assertUnchanged(): Promise<void> {
    const read = await this.io.readManifest();
    this.counters.manifestReads += 1;
    if (read.kind === "ok") this.counters.manifestBytesRead += read.bytes.byteLength;
    if (!sameBytes(this.bytes, read.kind === "ok" ? read.bytes : null)) {
      throw new IndexedStoreError("indexed_store_concurrent_change", `store ${this.io.store} changed after it was read; nothing was published`);
    }
  }
}
