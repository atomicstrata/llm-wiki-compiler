/**
 * @file test/segments/store.test.ts
 * @description The durable segment store on real disk: restart-safe lookups
 * and keyset scans, newest-wins and tombstones across runs, merges that keep
 * every input on disk, and counters that show a narrow read touches a bounded
 * number of segments and blocks however large the store is.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { BLOCK_TARGET_BYTES, MAX_RUNS, type SegmentRow } from "../../src/segments/contracts.js";
import { newCounters } from "../../src/segments/counters.js";
import { diskSegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import { verifyStore } from "../../src/segments/verify.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-segments-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A fresh snapshot of store `name`, with its own counters. */
const open = (name = "catalog") => SegmentStore.open(diskSegmentStoreIo(root, name), { counters: newCounters() });
/** `count` rows `k00000…` with a value naming the round. */
function rows(count: number, round: string, from = 0): SegmentRow[] {
  return Array.from({ length: count }, (_, at) => ({ k: `k${String(from + at).padStart(6, "0")}`, v: { round, payload: "x".repeat(64) } }));
}
/** Every live row of a snapshot. */
async function all(store: SegmentStore, options = {}): Promise<SegmentRow[]> {
  const out: SegmentRow[] = [];
  for await (const row of store.scan(options)) out.push(row);
  return out;
}

describe("restart-safe reads", () => {
  it("reads committed rows back after reopening, by point and by keyset from any position", async () => {
    await (await open()).commit({ rows: rows(10_000, "a"), meta: { note: "built" } });
    const store = await open();
    expect(store.meta).toEqual({ note: "built" });
    expect(await store.get("k004321")).toMatchObject({ round: "a" });
    expect(await store.get("missing")).toBeUndefined();
    const page: SegmentRow[] = [];
    for await (const row of store.scan({ after: "k009990" })) page.push(row);
    expect(page.map((row) => row.k)).toEqual(rows(9, "a", 9991).map((row) => row.k));
  });

  it("lets a newer run win, hides rows behind a tombstone, and scans by prefix", async () => {
    let store = await (await open()).commit({ rows: rows(100, "old") });
    store = await store.commit({ rows: [{ k: "k000005", v: "new" }, { k: "k000006", d: 1 }] });
    const reopened = await open();
    expect(await reopened.get("k000005")).toBe("new");
    expect(await reopened.get("k000006")).toBeUndefined();
    expect((await all(reopened, { prefix: "k00000" })).map((row) => row.k)).toEqual(["k000000", "k000001", "k000002", "k000003", "k000004", "k000005", "k000007", "k000008", "k000009"]);
    expect(store.manifest.generation).toBe(2);
  });
});

describe("bounded work", () => {
  it("answers a point lookup with at most one index and one block per covering run", async () => {
    await (await open()).commit({ rows: rows(20_000, "big") });
    const store = await open();
    await store.get("k012345");
    expect(store.manifest.runs).toHaveLength(1);
    expect(store.counters).toMatchObject({ manifestReads: 1, segmentsOpened: 1, blocksRead: 1 });
    // One block is at most BLOCK_TARGET_BYTES of rows; each row here is over 100 bytes.
    expect(store.counters.rowsDecoded).toBeLessThanOrEqual(Math.ceil(BLOCK_TARGET_BYTES / 100));
  });

  it("reads one block per run for a short keyset page, independent of store size", async () => {
    await (await open()).commit({ rows: rows(20_000, "big") });
    const store = await open();
    let taken = 0;
    for await (const row of store.scan({ after: "k015000" })) { expect(row.k > "k015000").toBe(true); if (++taken === 50) break; }
    // One run: the page needs the block holding its start and at most the next one (and its segment).
    expect(store.counters.segmentsOpened).toBeLessThanOrEqual(2);
    expect(store.counters.blocksRead).toBeLessThanOrEqual(2);
    expect(store.counters.rowsDecoded).toBeLessThanOrEqual(2 * Math.ceil(BLOCK_TARGET_BYTES / 100));
  });
});

describe("a prefix scan from an earlier cursor", () => {
  it("starts at the later of the two bounds, reading no earlier block", async () => {
    await (await open()).commit({ rows: rows(20_000, "big") });
    const store = await open();
    const page: SegmentRow[] = [];
    for await (const row of store.scan({ prefix: "k0199", after: "k000001" })) page.push(row);
    expect(page.map((row) => row.k)).toEqual(rows(100, "big", 19_900).map((row) => row.k));
    expect(store.counters.blocksRead).toBeLessThanOrEqual(2);
  });
});

describe("merging without deleting", () => {
  it("bounds the run count under many small commits, keeps newest values, and retains merged inputs", async () => {
    let store = await open();
    for (let round = 0; round < 70; round += 1) store = await store.commit({ rows: [{ k: `k${String(round % 10).padStart(6, "0")}`, v: round }] });
    const reopened = await open();
    expect(reopened.manifest.runs.length).toBeLessThanOrEqual(MAX_RUNS);
    expect(await reopened.get("k000009")).toBe(69);
    expect((await all(reopened)).length).toBe(10);
    const report = await verifyStore(reopened);
    expect(report.retainedLeaves).toBeGreaterThan(0);
    expect(report.retainedBytes).toBeGreaterThan(0);
  });
});
