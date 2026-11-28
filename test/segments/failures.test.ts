/**
 * @file test/segments/failures.test.ts
 * @description Failure behaviour of the durable segment store on real disk:
 * conditional publication against a stale snapshot and a delayed stale
 * writer (nothing published, the orphan retained), and fail-closed reads of a
 * tampered segment, a manifest with an unknown key, a linked manifest and a
 * missing segment. Nothing ever falls back to another copy. The LAST
 * pre-publication seam (R38): the atomic writer's `beforeReplace` runs with
 * the complete temp present and its rejection publishes nothing; a stale
 * writer paused there (its durable temp holding the next manifest) while
 * another commits is refused, leaving the winner's manifest untouched. A
 * failure reported as post-commit (R25) is always an unknown outcome.
 */

import { appendFile, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { IndexedStoreError } from "../../src/segments/contracts.js";
import { diskSegmentStoreIo, type SegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import { atomicWrite, AtomicWritePostCommitError } from "../../src/utils/atomic-write.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-segfail-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const dir = () => path.join(root, ".llmwiki", "indexed", "events");
const open = (io: SegmentStoreIo = diskSegmentStoreIo(root, "events")) => SegmentStore.open(io);
const ROWS = Array.from({ length: 50 }, (_, at) => ({ k: `e${String(at).padStart(4, "0")}`, v: { at } }));
/** The code a promise rejects with. */
async function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(() => "resolved", (error) => (error instanceof IndexedStoreError ? error.code : String(error)));
}
/** The only referenced segment's path. */
async function segmentPath(): Promise<string> {
  return path.join(dir(), (await open()).manifest.runs[0]!.segments[0]!.name);
}

describe("conditional publication", () => {
  it("refuses a commit from a snapshot older than the published manifest, writing no manifest", async () => {
    const first = await (await open()).commit({ rows: ROWS });
    const stale = await open();
    await first.commit({ rows: [{ k: "e9999", v: "winner" }] });
    const before = await readFile(path.join(dir(), "manifest.json"));
    expect(await code(stale.commit({ rows: [{ k: "e9998", v: "loser" }] }))).toBe("indexed_store_concurrent_change");
    expect(await readFile(path.join(dir(), "manifest.json"))).toEqual(before);
  });

  it("refuses a delayed stale writer at the last pre-publication seam and retains its orphan segment", async () => {
    await (await open()).commit({ rows: ROWS });
    const disk = diskSegmentStoreIo(root, "events");
    const delayed: SegmentStoreIo = {
      ...disk,
      publishManifest: async (bytes, revalidate) => {
        await (await open()).commit({ rows: [{ k: "e8000", v: "interleaved" }] });
        await disk.publishManifest(bytes, revalidate);
      },
    };
    const leavesBefore = (await readdir(dir())).length;
    expect(await code((await open(delayed)).commit({ rows: [{ k: "e7000", v: "stale" }] }))).toBe("indexed_store_concurrent_change");
    const after = await open();
    expect([await after.get("e8000"), await after.get("e7000")]).toEqual(["interleaved", undefined]);
    expect((await readdir(dir())).length).toBeGreaterThan(leavesBefore + 1);
  });
});

describe("fail-closed reads", () => {
  it("refuses a tampered block and a truncated segment", async () => {
    await (await open()).commit({ rows: ROWS });
    const file = await segmentPath();
    const bytes = await readFile(file);
    bytes[5] = bytes[5]! ^ 1;
    await unlink(file);
    await writeFile(file, bytes);
    expect(await code((await open()).get("e0001"))).toBe("indexed_store_corrupt");
    await appendFile(file, "x");
    expect(await code((await open()).get("e0001"))).toBe("indexed_store_corrupt");
  });

  it("refuses a manifest with an unknown key, a linked manifest and a missing segment", async () => {
    await (await open()).commit({ rows: ROWS });
    const manifest = path.join(dir(), "manifest.json");
    const original = await readFile(manifest, "utf8");
    await writeFile(manifest, original.replace('"meta":{}', '"meta":{},"extra":1'));
    expect(await code(open())).toBe("indexed_store_corrupt");
    await rm(manifest);
    await writeFile(path.join(root, "elsewhere.json"), original);
    await symlink(path.join(root, "elsewhere.json"), manifest);
    expect(await code(open())).toBe("indexed_store_unavailable");
    await rm(manifest);
    await writeFile(manifest, original);
    await rm(await segmentPath());
    expect(await code((await open()).get("e0001"))).toBe("indexed_store_corrupt");
  });
});

/** The temp leaves beside `leaf` in `dir`. */
async function temps(inDir: string, leaf: string): Promise<string[]> {
  return (await readdir(inDir)).filter((name) => name.startsWith(`${leaf}.`) && name.endsWith(".tmp"));
}

describe("the atomic writer's last seam", () => {
  it("runs with the complete temp present and publishes nothing when it rejects", async () => {
    const file = path.join(root, "leaf.json");
    await writeFile(file, "old");
    let seen: string[] = [];
    const refused = atomicWrite(file, "new", { confineRoot: root, durable: true, strictDurability: true, beforeReplace: async () => {
      seen = await Promise.all((await temps(root, "leaf.json")).map((name) => readFile(path.join(root, name), "utf8")));
      throw new Error("changed underneath");
    } });
    await expect(refused).rejects.toThrow("changed underneath");
    expect(seen).toEqual(["new"]);
    expect(await readFile(file, "utf8")).toBe("old");
    expect(await temps(root, "leaf.json")).toEqual([]);
  });
});

describe("a stale segment writer paused at the last seam", () => {
  it("is refused after another writer commits, leaving the winner's manifest untouched", async () => {
    const disk = diskSegmentStoreIo(root, "events");
    await (await SegmentStore.open(disk)).commit({ rows: [{ k: "e0", v: 0 }] });
    let tempHeldNext = false;
    let winner = Buffer.alloc(0);
    const paused: SegmentStoreIo = {
      ...disk,
      publishManifest: (bytes, revalidate) => disk.publishManifest(bytes, async () => {
        const [temp] = await temps(dir(), "manifest.json");
        tempHeldNext = temp !== undefined && (await readFile(path.join(dir(), temp))).equals(bytes);
        await (await SegmentStore.open(disk)).commit({ rows: [{ k: "w", v: "winner" }] });
        winner = await readFile(path.join(dir(), "manifest.json"));
        await revalidate();
      }),
    };
    expect(await code((await SegmentStore.open(paused)).commit({ rows: [{ k: "loser", v: 1 }] }))).toBe("indexed_store_concurrent_change");
    expect(tempHeldNext).toBe(true);
    expect(await readFile(path.join(dir(), "manifest.json"))).toEqual(winner);
    const after = await SegmentStore.open(disk);
    expect([await after.get("w"), await after.get("loser")]).toEqual(["winner", undefined]);
  });
});

describe("a post-commit failure", () => {
  it("is an unknown outcome even when a re-read finds the previous manifest", async () => {
    const disk = diskSegmentStoreIo(root, "events");
    await (await SegmentStore.open(disk)).commit({ rows: [{ k: "e0", v: 0 }] });
    const reportsPostCommit: SegmentStoreIo = { ...disk, publishManifest: async () => { throw new AtomicWritePostCommitError(new Error("parent changed after rename")); } };
    expect(await code((await SegmentStore.open(reportsPostCommit)).commit({ rows: [{ k: "e1", v: 1 }] }))).toBe("indexed_store_outcome_unknown");
  });
});
