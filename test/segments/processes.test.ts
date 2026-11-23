/**
 * @file test/segments/processes.test.ts
 * @description Conditional publication between REAL processes: a child reads
 * the manifest and is held; this process publishes; the released child must
 * refuse with `indexed_store_concurrent_change` and publish nothing. It
 * refuses at the commit's opening comparison, before writing a segment; the
 * final pre-publication seam is witnessed in `failures.test.ts`.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeAll, beforeEach } from "../config/storage-profile-hooks.js";
import { diskSegmentStoreIo } from "../../src/segments/io.js";
import { SegmentStore } from "../../src/segments/store.js";
import { bundleChild, childEnd, startChild } from "../helpers-child-process.js";

let script: string;
let root: string;
beforeAll(async () => { script = await bundleChild("test/segments/fixtures/commit-child.ts"); });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-segproc-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Wait until `file` exists. */
async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) await sleep(10);
}

describe("two real processes", () => {
  it("lets the held stale writer lose at publication, leaving the winner's manifest", async () => {
    await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e0", v: 0 }] });
    const ready = path.join(root, "ready");
    const go = path.join(root, "go");
    const child = startChild(script, [root, "events", "e-child", ready, go]);
    const ended = childEnd(child);
    await waitFor(ready);
    await (await SegmentStore.open(diskSegmentStoreIo(root, "events"))).commit({ rows: [{ k: "e-parent", v: "won" }] });
    const leaves = (await readdir(path.join(root, ".llmwiki", "indexed", "events"))).length;
    await writeFile(go, "go");
    expect((await ended).json).toEqual({ outcome: "indexed_store_concurrent_change" });
    const after = await SegmentStore.open(diskSegmentStoreIo(root, "events"));
    expect([await after.get("e-parent"), await after.get("e-child")]).toEqual(["won", undefined]);
    expect((await readdir(path.join(root, ".llmwiki", "indexed", "events"))).length).toBe(leaves);
  });
});
