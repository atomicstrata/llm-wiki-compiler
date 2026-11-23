/**
 * @file test/segments/verification-cache-concurrency.test.ts
 * @description The verification cache's hard bounds hold under CONCURRENT
 * use, over a deterministic in-memory IO that counts live physical handles:
 * concurrent opens of different segments never exceed the handle cap,
 * concurrent opens of one segment share one physical handle, a close fences
 * opens still in flight and refuses every later open or read, and two
 * concurrent misses of the same slice are counted once.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "bun:test";
import { newCounters } from "../../src/segments/counters.js";
import type { SegmentStoreIo } from "../../src/segments/io.js";
import { VerificationCache } from "../../src/segments/verification-cache.js";

const SLICE = 1024;

/** An in-memory store IO whose opens take `delayMs`, tracking live and peak physical handles. */
function fakeIo(delayMs = 5) {
  const live = { now: 0, peak: 0, opens: 0 };
  const io: SegmentStoreIo = {
    store: "events",
    readManifest: async () => ({ kind: "absent" }),
    listLeaves: async () => ({ kind: "absent" }),
    writeSegment: async () => {}, publishManifest: async () => {},
    openSegment: async () => {
      await sleep(delayMs);
      live.now += 1; live.opens += 1; live.peak = Math.max(live.peak, live.now);
      let open = true;
      return { size: 4 * SLICE, readAt: async (position, length) => { await sleep(1); return Buffer.alloc(length, position % 251); }, close: async () => { if (open) { open = false; live.now -= 1; } } };
    },
  };
  return { io, live };
}

describe("concurrent opens", () => {
  it("never hold more physical handles than the cap", async () => {
    const { io, live } = fakeIo();
    const cache = new VerificationCache(io, newCounters(), { maxHandles: 1, maxBytes: 0 });
    const outcomes = await Promise.allSettled([cache.io.openSegment("r1-0-00000001.seg"), cache.io.openSegment("r2-0-00000002.seg")]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(live.peak).toBe(1);
    await cache.close();
    expect(live.now).toBe(0);
  });

  it("of one segment share one physical handle, closed with the cache", async () => {
    const { io, live } = fakeIo();
    const cache = new VerificationCache(io, newCounters(), { maxHandles: 2, maxBytes: 0 });
    const handles = await Promise.all([cache.io.openSegment("r1-0-00000001.seg"), cache.io.openSegment("r1-0-00000001.seg")]);
    for (const handle of handles) await handle.close();
    expect([live.opens, live.peak]).toEqual([1, 1]);
    await cache.close();
    expect(live.now).toBe(0);
  });
});

describe("closing", () => {
  it("fences an open still in flight and refuses every later open or read", async () => {
    const { io, live } = fakeIo(30);
    const cache = new VerificationCache(io, newCounters(), { maxHandles: 4, maxBytes: 0 });
    const early = await cache.io.openSegment("r1-0-00000001.seg");
    const inFlight = cache.io.openSegment("r2-0-00000002.seg").catch((error: Error) => error);
    await cache.close();
    await inFlight;
    expect(live.now).toBe(0);
    await expect(cache.io.openSegment("r3-0-00000003.seg")).rejects.toThrow(/cache of events is closed/);
    await expect(early.readAt(0, SLICE)).rejects.toThrow(/cache of events is closed/);
  });
});

describe("concurrent slice misses", () => {
  it("count a slice's bytes once, so a second slice still fits without eviction", async () => {
    const { io } = fakeIo();
    const counters = newCounters();
    const cache = new VerificationCache(io, counters, { maxHandles: 2, maxBytes: 2 * SLICE });
    const handle = await cache.io.openSegment("r1-0-00000001.seg");
    await Promise.all([handle.readAt(0, SLICE), handle.readAt(0, SLICE)]);
    await handle.readAt(SLICE, SLICE);
    expect([counters.cacheMisses, counters.cacheEvictions]).toEqual([3, 0]);
    await cache.close();
  });
});
