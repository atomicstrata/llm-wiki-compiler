/**
 * @file test/segments/limits.test.ts
 * @description Hard limits and outcome contracts of the segment primitive:
 * hostile footers, rows and trailers are typed corruption; the manifest's
 * finite ceiling refuses before publication; a cap merge of an OLDER adjacent
 * pair keeps age order and newest-wins across a reopen; and a manifest
 * publication that fails after its rename is reported as an unknown outcome
 * whose published state a reopen reconciles. A store directory that cannot
 * be listed in full is never mistaken for an empty one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { IndexedStoreError, MAX_FOOTER_BYTES, MAX_RUNS, type RunEntry } from "../../src/segments/contracts.js";
import { decodeBlock, decodeFooter, decodeTrailer, sha256Hex } from "../../src/segments/format.js";
import { diskSegmentStoreIo, type SegmentStoreIo } from "../../src/segments/io.js";
import { emptyManifest, serializeManifest } from "../../src/segments/manifest.js";
import { SegmentStore } from "../../src/segments/store.js";
import { verifyStore } from "../../src/segments/verify.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-seglimits-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The code a thunk throws or rejects with. */
async function code(run: () => unknown): Promise<string> {
  try { await run(); return "resolved"; } catch (error) { return error instanceof IndexedStoreError ? error.code : String(error); }
}
const BLOCK = { first: "a", last: "a", offset: 0, length: 5, rows: 1, sha256: "0".repeat(64) };

describe("hostile segment metadata", () => {
  it("refuses an oversized footer length before allocating it, and footers with extra keys or huge blocks", async () => {
    expect(await code(() => decodeTrailer(Buffer.from(`${String(MAX_FOOTER_BYTES + 1).padStart(15, "0")}\n`), 1e9))).toBe("indexed_store_corrupt");
    const footer = (value: object) => Buffer.from(JSON.stringify({ format: "llmwiki-segment", version: 1, rows: 1, blocks: [BLOCK], ...value }));
    expect(await code(() => decodeFooter(footer({ extra: 1 }), 5))).toBe("indexed_store_corrupt");
    expect(await code(() => decodeFooter(footer({ blocks: [{ ...BLOCK, length: 1e9 }] }), 1e9))).toBe("indexed_store_corrupt");
    expect(await code(() => decodeFooter(footer({ blocks: [{ ...BLOCK, extra: 1 }] }), 5))).toBe("indexed_store_corrupt");
  });

  it("types null, array and oddly shaped rows as corruption", async () => {
    for (const line of ["null", "[]", '{"k":"a"}', '{"k":"a","v":1,"d":1}', '{"k":"","v":1}']) {
      expect(await code(() => decodeBlock(Buffer.from(`${line}\n`), { ...BLOCK, sha256: sha256Hex(Buffer.from(`${line}\n`)) }))).toBe("indexed_store_corrupt");
    }
  });
});

describe("the flat manifest ceiling", () => {
  it("refuses to serialize a manifest past its byte ceiling, so it is never published", async () => {
    const segments = Array.from({ length: 6000 }, (_, at) => ({
      name: `r0-${at}-00000000.seg`, minKey: `k${String(at).padStart(8, "0")}a`, maxKey: `k${String(at).padStart(8, "0")}b`,
      rows: 1, bytes: 100, sha256: "a".repeat(64), indexSha256: "b".repeat(64),
    }));
    const run: RunEntry = { id: 0, rows: 6000, segments };
    expect(await code(() => serializeManifest({ ...emptyManifest("catalog"), generation: 1, nextRunId: 1, runs: [run] }))).toBe("indexed_store_invalid_write");
  });
});

describe("age order under the run cap", () => {
  it("merges an older adjacent pair under a fresh id and keeps newest-wins and tombstones after reopening", async () => {
    let store = await SegmentStore.open(diskSegmentStoreIo(root, "catalog"));
    const sizes = [1, 9, 70];
    for (let commit = 0; commit <= MAX_RUNS; commit += 1) {
      const size = sizes[commit % sizes.length]!;
      const rows = Array.from({ length: size }, (_, at) => ({ k: `c${String(commit).padStart(3, "0")}-${String(at).padStart(3, "0")}`, v: commit }));
      store = await store.commit({ rows: [{ k: "shared", v: commit }, ...rows].sort((a, b) => (a.k < b.k ? -1 : 1)) });
    }
    store = await store.commit({ rows: [{ k: "c000-000", d: 1 }] });
    const reopened = await SegmentStore.open(diskSegmentStoreIo(root, "catalog"));
    const ids = reopened.manifest.runs.map((run) => run.id);
    expect(reopened.manifest.runs.length).toBeLessThanOrEqual(MAX_RUNS);
    expect(ids.some((id, at) => at > 0 && id < ids[at - 1]!)).toBe(true);
    expect([await reopened.get("shared"), await reopened.get("c000-000"), await reopened.get(`c${String(MAX_RUNS).padStart(3, "0")}-000`)]).toEqual([MAX_RUNS, undefined, MAX_RUNS]);
  });
});

describe("a publication whose outcome is unknown", () => {
  it("reports a failure after the rename as outcome-unknown, and a reopen sees the published state", async () => {
    const disk = diskSegmentStoreIo(root, "events");
    const failsAfterRename: SegmentStoreIo = {
      ...disk, publishManifest: async (bytes, revalidate) => { await disk.publishManifest(bytes, revalidate); throw new Error("directory fsync failed"); },
    };
    expect(await code(async () => (await SegmentStore.open(failsAfterRename)).commit({ rows: [{ k: "e1", v: 1 }] }))).toBe("indexed_store_outcome_unknown");
    const reopened = await SegmentStore.open(disk);
    expect(await reopened.get("e1")).toBe(1);
    expect(await (await reopened.commit({ rows: [{ k: "e2", v: 2 }] })).get("e2")).toBe(2);
  });

  it("passes through a failure before the rename with nothing published", async () => {
    const disk = diskSegmentStoreIo(root, "events");
    const failsEarly: SegmentStoreIo = { ...disk, publishManifest: async () => { throw new Error("disk full"); } };
    expect(await code(async () => (await SegmentStore.open(failsEarly)).commit({ rows: [{ k: "e1", v: 1 }] }))).toContain("disk full");
    expect((await SegmentStore.open(disk)).exists).toBe(false);
  });
});

describe("an incomplete store-directory listing", () => {
  it("makes verification refuse instead of reporting zero retained leaves", async () => {
    const disk = diskSegmentStoreIo(root, "events");
    await (await SegmentStore.open(disk)).commit({ rows: [{ k: "e1", v: 1 }] });
    const unlistable: SegmentStoreIo = { ...disk, listLeaves: async () => ({ kind: "incomplete" }) };
    expect(await code(async () => verifyStore(await SegmentStore.open(unlistable)))).toBe("indexed_store_unavailable");
    expect((await verifyStore(await SegmentStore.open(disk))).retainedLeaves).toBe(0);
  });
});
