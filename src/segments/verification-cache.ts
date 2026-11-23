/**
 * @file src/segments/verification-cache.ts
 * @description VERIFICATION-ONLY reads: a bounded cache of immutable segment
 * handles and byte slices, scoped to ONE store's full verification, plus the
 * counting wrapper that measures physical work at the raw IO boundary.
 *
 * WHY. Full verification checks every record against the point indexes it
 * must have (exact point joins). Each lookup opens every covering run's
 * segment and reads its trailer, block index and one block, so the same
 * footers and blocks are read again and again. Segments never change once
 * written, and the verifying process holds its reader lease (a collector
 * refuses meanwhile), so a slice read once is the same bytes as on disk.
 *
 * BOUNDS. At most {@link VerificationCacheLimits.maxHandles} physical handles
 * are open, pinned (in use by a reader) or not; past that, an open refuses
 * rather than exceed it. Cached slices total at most
 * {@link VerificationCacheLimits.maxBytes}, least recently used first out, and
 * each cached slice owns exactly its bytes. {@link VerificationCache.close}
 * closes every handle and is always called (`withVerificationReads`).
 *
 * WHAT IS NEVER CACHED. The fresh whole-segment SHA-256 (`./verify.ts`)
 * reads through {@link CachedSegmentIo.uncached}, as do the retained-leaf
 * inventory and directory listing; nothing outside a verification ever sees
 * the cache, and the validators themselves are unchanged.
 */

import { IndexedStoreError } from "./contracts.js";
import type { IoCounters } from "./counters.js";
import type { SegmentHandle, SegmentStoreIo } from "./io.js";
import type { SegmentStore } from "./store.js";

/** The cache's hard bounds. */
export interface VerificationCacheLimits {
  readonly maxHandles: number;
  readonly maxBytes: number;
}

/**
 * Default bounds: room for every run of a store (at most 48) to be pinned by
 * a scan while lookups open one more, and 64 MiB of slices.
 */
const DEFAULT_LIMITS: VerificationCacheLimits = { maxHandles: 64, maxBytes: 64 * 1024 * 1024 };

/** A store IO whose segment reads may come from a verification cache, with the raw IO beside it. */
export interface CachedSegmentIo extends SegmentStoreIo {
  /** The uncached (counted) raw IO: fresh whole-segment digests, inventory and listings use it. */
  readonly uncached: SegmentStoreIo;
}

/** The raw IO of `store` for work that must never be cached. */
export function uncachedIo(store: SegmentStore): SegmentStoreIo {
  return (store.io as Partial<CachedSegmentIo>).uncached ?? store.io;
}

/** `raw`, counting physical manifest reads, segment opens, bytes read, listings and lease checks into `counters`. */
function countedIo(raw: SegmentStoreIo, counters: IoCounters): SegmentStoreIo {
  return {
    ...raw,
    readManifest: () => { counters.physicalManifestReads += 1; counters.leaseChecks += 1; return raw.readManifest(); },
    openSegment: async (name) => {
      counters.physicalSegmentOpens += 1;
      counters.leaseChecks += 1;
      const handle = await raw.openSegment(name);
      return {
        size: handle.size, close: () => handle.close(),
        readAt: async (position, length) => { const bytes = await handle.readAt(position, length); counters.physicalSegmentBytesRead += length; return bytes; },
      };
    },
    listLeaves: (max) => { counters.physicalListings += 1; return raw.listLeaves(max); },
  };
}

/** One physical handle and how many readers hold it. */
interface HandleEntry { readonly handle: SegmentHandle; pins: number }

/** A bounded cache of segment handles and slices for one store's verification. */
export class VerificationCache {
  private readonly handles = new Map<string, HandleEntry>();
  private readonly slices = new Map<string, Buffer>();
  private sliceBytes = 0;
  /** Serializes every physical open and eviction, so the handle cap holds under concurrent opens. */
  private physicalQueue: Promise<unknown> = Promise.resolve();
  /** Set by {@link close}: no open and no read is served after it. */
  private closed = false;

  constructor(private readonly raw: SegmentStoreIo, private readonly counters: IoCounters, private readonly limits: VerificationCacheLimits = DEFAULT_LIMITS) {
    const valid = Number.isSafeInteger(limits.maxHandles) && limits.maxHandles >= 1 && Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 0;
    if (!valid) throw new IndexedStoreError("indexed_store_invalid_write", "verification cache limits must be whole numbers (at least one handle)");
  }

  /** The cached view of the store's IO. Writes refuse: a verification never publishes. */
  get io(): CachedSegmentIo {
    const refuse = (): never => { throw new IndexedStoreError("indexed_store_invalid_write", "a verification read view cannot write"); };
    return {
      store: this.raw.store, uncached: this.raw, readManifest: () => this.raw.readManifest(), listLeaves: (max) => this.raw.listLeaves(max),
      openSegment: (name) => this.open(name), writeSegment: async () => refuse(), publishManifest: async () => refuse(),
    };
  }

  /** A pinned view of segment `name`; closing it unpins once. */
  private async open(name: string): Promise<SegmentHandle> {
    const entry = await this.pinned(name);
    let held = true;
    return {
      size: entry.handle.size,
      readAt: (position, length) => this.read(name, entry, position, length),
      close: async () => { if (held) { held = false; entry.pins -= 1; } },
    };
  }

  /**
   * The physical handle of `name`, already PINNED for the caller. A cached
   * entry is pinned synchronously; otherwise the open runs in the serialized
   * queue (re-checking the cache, evicting idle handles, refusing past the
   * cap) and pins before the queue moves on, so no eviction can close it first.
   */
  private pinned(name: string): Promise<HandleEntry> {
    if (this.closed) return Promise.reject(this.closedError());
    const cached = this.handles.get(name);
    if (cached !== undefined) { this.touch(name, cached); return Promise.resolve(cached); }
    const opening = this.physicalQueue.then(() => this.openPhysical(name));
    this.physicalQueue = opening.catch(() => {});
    return opening;
  }

  /** The refusal of any use after {@link close}. */
  private closedError(): IndexedStoreError {
    return new IndexedStoreError("indexed_store_unavailable", `the verification cache of ${this.raw.store} is closed`);
  }

  /** Mark `entry` most recently used and pin it, in one synchronous step. */
  private touch(name: string, entry: HandleEntry): void {
    this.handles.delete(name);
    this.handles.set(name, entry);
    entry.pins += 1;
  }

  /** Inside the queue: reuse, or evict idle handles and open within the cap; returns the entry pinned. */
  private async openPhysical(name: string): Promise<HandleEntry> {
    if (this.closed) throw this.closedError();
    const cached = this.handles.get(name);
    if (cached !== undefined) { this.touch(name, cached); return cached; }
    await this.evictIdleHandles(this.limits.maxHandles - 1);
    if (this.handles.size >= this.limits.maxHandles) throw new IndexedStoreError("indexed_store_unavailable", `verification of ${this.raw.store} would hold more than ${this.limits.maxHandles} segment handles`);
    const entry: HandleEntry = { handle: await this.raw.openSegment(name), pins: 1 };
    this.handles.set(name, entry);
    return entry;
  }

  /** Close unpinned handles, least recently used first, until at most `keep` remain (each check-and-remove is one synchronous step). */
  private async evictIdleHandles(keep: number): Promise<void> {
    for (const [name, entry] of [...this.handles]) {
      if (this.handles.size <= keep) return;
      if (entry.pins > 0 || this.handles.get(name) !== entry) continue;
      this.handles.delete(name);
      await entry.handle.close().catch(() => {});
    }
  }

  /** Bytes `[position, position + length)` of `name`, from the slice cache or the disk. */
  private async read(name: string, entry: HandleEntry, position: number, length: number): Promise<Buffer> {
    if (this.closed) throw this.closedError();
    const key = `${name}\t${position}\t${length}`;
    const hit = this.slices.get(key);
    if (hit !== undefined) {
      this.counters.cacheHits += 1;
      this.slices.delete(key);
      this.slices.set(key, hit);
      return hit;
    }
    this.counters.cacheMisses += 1;
    const bytes = await entry.handle.readAt(position, length);
    this.remember(key, bytes);
    return bytes;
  }

  /** Keep `bytes` within the byte cap, evicting least recently used slices; a slice owns exactly its bytes. */
  private remember(key: string, bytes: Buffer): void {
    // A concurrent miss of the same slice may already have stored it: never count its bytes twice.
    if (bytes.byteLength > this.limits.maxBytes || this.slices.has(key)) return;
    const owned = bytes.buffer.byteLength === bytes.byteLength ? bytes : Buffer.from(bytes);
    for (const [oldest, slice] of this.slices) {
      if (this.sliceBytes + owned.byteLength <= this.limits.maxBytes) break;
      this.slices.delete(oldest);
      this.sliceBytes -= slice.byteLength;
      this.counters.cacheEvictions += 1;
    }
    this.slices.set(key, owned);
    this.sliceBytes += owned.byteLength;
  }

  /** Close every handle, pinned or not, and drop every slice, after any open still in the queue. */
  async close(): Promise<void> {
    this.closed = true;
    // Fence: an open already queued finishes (and is then closed below); none can start after.
    await this.physicalQueue;
    const entries = [...this.handles.values()];
    this.handles.clear();
    this.slices.clear();
    this.sliceBytes = 0;
    for (const entry of entries) await entry.handle.close().catch(() => {});
  }
}

/**
 * Run one store's full verification over a fresh cache: `work` receives the
 * same snapshot reading through the cache (raw work counted physically), and
 * the cache is closed on every outcome.
 */
export async function withVerificationReads<T>(store: SegmentStore, work: (cached: SegmentStore) => Promise<T>, limits?: VerificationCacheLimits): Promise<T> {
  const cache = new VerificationCache(countedIo(store.io, store.counters), store.counters, limits);
  try {
    return await work(store.withIo(cache.io));
  } finally {
    await cache.close();
  }
}

/**
 * Run a verification that reads by STREAMING only (no point lookups to
 * repeat), with its raw work counted physically and nothing cached: several
 * concurrent scans would pin more handles than the cache allows, and a
 * single sequential pass gains nothing from it.
 */
export function withCountedReads<T>(store: SegmentStore, work: (counted: SegmentStore) => Promise<T>): Promise<T> {
  const counted = countedIo(store.io, store.counters);
  const view: CachedSegmentIo = { ...counted, uncached: counted };
  return work(store.withIo(view));
}
