/**
 * @file src/segments/verify.ts
 * @description FULL verification of one store: explicit, cold, O(stored
 * bytes) work, never run by a narrow operation.
 *
 * Every referenced segment is read whole, FRESH from disk (never from a
 * verification cache), and checked against its manifest SHA-256; then its
 * block index and every block are decoded and checked from those same bytes
 * through the same bounded reader the scans use: one physical pass. Leaves in the store directory that no
 * manifest entry names are REPORTED as retained (superseded runs, crashed
 * commits' orphans, leftover temps), measured by size, with any leaf that
 * cannot be opened counted as unmeasured; this build never deletes them. A visitor may inspect
 * every stored row, oldest run first, for store-specific checks.
 */

import { corrupt, IndexedStoreError, MANIFEST_LEAF, type SegmentRow } from "./contracts.js";
import { sha256Hex } from "./format.js";
import type { SegmentHandle, SegmentStoreIo } from "./io.js";
import { SegmentReader } from "./reader.js";
import type { SegmentStore } from "./store.js";
import { uncachedIo } from "./verification-cache.js";

/** Upper bound on directory entries a verification lists. */
const MAX_LISTED_LEAVES = 1_000_000;

/**
 * One store's on-disk inventory, from a full verification. Every leaf the
 * manifest does not reference (superseded runs, crashed commits' segments,
 * leftover temps) is RETAINED and measured by size; a leaf that cannot be
 * opened confined (a link, a special file, a vanished name) is counted as
 * UNMEASURED, so `complete` is false rather than the bytes silently low.
 */
export interface StorageInventoryV1 {
  readonly segments: number;
  readonly referencedBytes: number;
  readonly retainedLeaves: number;
  readonly retainedBytes: number;
  readonly unmeasuredLeaves: number;
  /** Whether every retained leaf was measured. */
  readonly complete: boolean;
}

/** What a full verification found. */
export interface StoreVerification extends StorageInventoryV1 {
  readonly storedRows: number;
}

/** A read-only IO serving one segment from bytes already read and digest-checked. */
function bytesIo(store: string, name: string, whole: Buffer): SegmentStoreIo {
  const handle: SegmentHandle = {
    size: whole.byteLength,
    readAt: async (position, length) => {
      if (!(Number.isSafeInteger(position) && Number.isSafeInteger(length) && position >= 0 && length >= 0 && position + length <= whole.byteLength)) corrupt("segment read is out of the file's bounds");
      return whole.subarray(position, position + length);
    },
    close: async () => {},
  };
  const never = (): never => corrupt(`segment ${name} is served from verified bytes only`);
  return { store, readManifest: async () => never(), openSegment: async (leaf) => (leaf === name ? handle : never()), writeSegment: async () => never(), publishManifest: async () => never(), listLeaves: async () => never() };
}

/**
 * Verify one referenced segment in ONE physical pass: read it whole FRESH
 * through the uncached raw IO, check its manifest SHA-256, then decode its
 * trailer, block index (checked against its own digest) and every block from
 * those same bytes through the ordinary bounded reader, handing rows to
 * `visit`. Detection is the same as reading it twice.
 */
async function verifySegment(store: SegmentStore, entry: SegmentReader["entry"], visit?: (row: SegmentRow) => void): Promise<void> {
  const raw = uncachedIo(store);
  const handle = await raw.openSegment(entry.name);
  let whole: Buffer;
  try {
    whole = await handle.readAt(0, entry.bytes);
    store.counters.segmentBytesRead += entry.bytes;
    if (handle.size !== entry.bytes || sha256Hex(whole) !== entry.sha256) corrupt(`segment ${entry.name} does not match its manifest digest`);
  } finally {
    await handle.close().catch(() => {});
  }
  const reader: SegmentReader = await SegmentReader.open(bytesIo(raw.store, entry.name, whole), entry, store.counters);
  try {
    for (let at = 0; at < reader.footer.blocks.length; at += 1) {
      const rows = await reader.readBlock(at);
      if (visit !== undefined) rows.forEach(visit);
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

/** Sizes of the leaves the manifest does not reference; an unopenable one is counted unmeasured, never skipped. */
async function retained(store: SegmentStore, referenced: ReadonlySet<string>): Promise<{ leaves: number; bytes: number; unmeasured: number }> {
  const kept = { leaves: 0, bytes: 0, unmeasured: 0 };
  const raw = uncachedIo(store);
  const listing = await raw.listLeaves(MAX_LISTED_LEAVES);
  if (listing.kind === "incomplete") throw new IndexedStoreError("indexed_store_unavailable", `${store.io.store} directory cannot be listed in full; the retained-leaf inventory would be incomplete`);
  for (const name of listing.kind === "ok" ? listing.names : []) {
    if (name === MANIFEST_LEAF || referenced.has(name)) continue;
    kept.leaves += 1;
    const handle = await raw.openSegment(name).catch(() => null);
    if (handle === null) { kept.unmeasured += 1; continue; }
    kept.bytes += handle.size;
    await handle.close().catch(() => {});
  }
  return kept;
}

/** Verify every referenced segment of `store` completely; corruption rejects. */
export async function verifyStore(store: SegmentStore, visit?: (row: SegmentRow, runId: number) => void): Promise<StoreVerification> {
  const referenced = new Set<string>();
  let referencedBytes = 0;
  for (const run of store.manifest.runs) {
    for (const entry of run.segments) {
      await verifySegment(store, entry, visit === undefined ? undefined : (row) => visit(row, run.id));
      referenced.add(entry.name);
      referencedBytes += entry.bytes;
    }
  }
  const kept = await retained(store, referenced);
  return {
    segments: referenced.size, storedRows: store.storedRows, referencedBytes,
    retainedLeaves: kept.leaves, retainedBytes: kept.bytes, unmeasuredLeaves: kept.unmeasured, complete: kept.unmeasured === 0,
  };
}

/** The storage inventory part of a store verification. */
export function storageOf(verification: StoreVerification): StorageInventoryV1 {
  const { segments, referencedBytes, retainedLeaves, retainedBytes, unmeasuredLeaves, complete } = verification;
  return { segments, referencedBytes, retainedLeaves, retainedBytes, unmeasuredLeaves, complete };
}
