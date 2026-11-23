/**
 * @file test/segments/verification-cache.test.ts
 * @description The verification-only cache answers repeated point-lookup
 * reads from memory with the SAME results, and counts physical work apart
 * from logical reads. The fresh whole-segment digest never comes from the
 * cache, so a byte corrupted after it was cached is still caught; tight
 * bounds evict without changing results; the handle cap refuses rather than
 * grow; every physical handle is closed on success and on failure.
 */

import { open as openFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { SegmentRow } from "../../src/segments/contracts.js";
import { newCounters } from "../../src/segments/counters.js";
import { diskSegmentStoreIo, type SegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import { withVerificationReads } from "../../src/segments/verification-cache.js";
import { verifyStore } from "../../src/segments/verify.js";

const KEYS = 2_000;
const RUNS = 3;
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-vcache-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Rows `k000…` for one run, each with a payload naming the run. */
function rows(run: number): SegmentRow[] {
  return Array.from({ length: KEYS }, (_, at) => ({ k: `k${String(at).padStart(6, "0")}`, v: { run, payload: "x".repeat(96) } }));
}

/** A store of `RUNS` overlapping runs (every key in every run), freshly reopened with its own counters. */
async function threeRuns(io: SegmentStoreIo = diskSegmentStoreIo(root, "events")): Promise<SegmentStore> {
  let store = await SegmentStore.open(io, { counters: newCounters() });
  for (let run = 0; run < RUNS; run += 1) store = await store.commit({ rows: rows(run) });
  return SegmentStore.open(io, { counters: newCounters() });
}

/** Look every key up twice: the verifier's repeated point-join pattern. */
async function lookups(store: SegmentStore): Promise<unknown[]> {
  const found: unknown[] = [];
  for (let pass = 0; pass < 2; pass += 1) for (let at = 0; at < KEYS; at += 1) found.push(await store.get(`k${String(at).padStart(6, "0")}`));
  return found;
}

describe("repeated point lookups", () => {
  it("return the same rows while physical opens and bytes fall below the logical reads", async () => {
    const plain = await threeRuns();
    const expected = await lookups(plain);
    const store = await SegmentStore.open(diskSegmentStoreIo(root, "events"), { counters: newCounters() });
    const found = await withVerificationReads(store, lookups);
    expect(found).toEqual(expected);
    const c = store.counters;
    expect(c.cacheHits).toBeGreaterThan(0);
    expect(c.physicalSegmentOpens).toBeLessThan(c.segmentsOpened);
    expect(c.physicalSegmentBytesRead).toBeLessThan(c.segmentBytesRead);
    expect(c.leaseChecks).toBe(c.physicalSegmentOpens + c.physicalManifestReads);
  });

  it("evict under tight bounds without changing a result", async () => {
    const expected = await lookups(await threeRuns());
    const store = await SegmentStore.open(diskSegmentStoreIo(root, "events"), { counters: newCounters() });
    const found = await withVerificationReads(store, lookups, { maxHandles: RUNS + 1, maxBytes: 100 * 1024 });
    expect(found).toEqual(expected);
    expect(store.counters.cacheEvictions).toBeGreaterThan(0);
  });

  it("refuse rather than hold more physical handles than the cap", async () => {
    const store = await threeRuns();
    const scanAll = async (cached: SegmentStore) => { for await (const _row of cached.scan()) { /* pins one handle per run */ } };
    await expect(withVerificationReads(store, scanAll, { maxHandles: RUNS - 1, maxBytes: 1024 * 1024 })).rejects.toThrow(/more than 2 segment handles/);
  });
});

describe("corruption parity", () => {
  it("catches a byte corrupted after it was cached: the whole-segment digest reads fresh", async () => {
    const store = await threeRuns();
    const outcome = withVerificationReads(store, async (cached) => {
      await lookups(cached);
      const segment = (await readdir(path.join(root, ".llmwiki", "indexed", "events"))).find((name) => name.endsWith(".seg"))!;
      const file = await openFile(path.join(root, ".llmwiki", "indexed", "events", segment), "r+");
      await file.write(Buffer.from("Z"), 0, 1, 20);
      await file.close();
      return verifyStore(cached);
    });
    await expect(outcome).rejects.toThrow(/does not match its manifest digest/);
  });
});

describe("handle lifetime", () => {
  /** A disk IO for `events` that tracks how many physical handles are open. */
  function trackedIo(open: { count: number }): SegmentStoreIo {
    const disk = diskSegmentStoreIo(root, "events");
    return {
      ...disk,
      openSegment: async (name) => {
        const handle = await disk.openSegment(name);
        open.count += 1;
        return { ...handle, readAt: handle.readAt, close: async () => { open.count -= 1; await handle.close(); } };
      },
    };
  }

  it("closes every physical handle after success and after a failure", async () => {
    const open = { count: 0 };
    const store = await threeRuns(trackedIo(open));
    await withVerificationReads(store, lookups);
    expect(open.count).toBe(0);
    await expect(withVerificationReads(store, async (cached) => { await lookups(cached); throw new Error("injected"); })).rejects.toThrow("injected");
    expect(open.count).toBe(0);
  });
});
