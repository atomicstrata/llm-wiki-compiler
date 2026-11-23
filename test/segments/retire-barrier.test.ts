/**
 * @file test/segments/retire-barrier.test.ts
 * @description The retirement barrier's own round trip, on a bare project
 * directory (no store is ever opened): a published barrier is one JSON line
 * ending in a real newline; while its owner (this process) is live it blocks
 * reads and only its own token removes it; a wrong token removes nothing; a
 * barrier whose owner exited is stale, blocks nothing and is removable as
 * stale (a live one is not); a barrier naming another host cannot be classified
 * here and blocks.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterAll, beforeAll } from "../config/storage-profile-hooks.js";
import { assertNoLiveRetirement, publishRetireBarrier, removeRetireBarrier, retireBarrierState } from "../../src/segments/retire-barrier.js";
import { CASE_TIMEOUT_MS, ok, removeRoots, runsChild, tempRoot } from "../indexed/run-retire-helpers.js";

const BARRIER = ".llmwiki/indexed-retire.json";
beforeAll(async () => { await runsChild(); });
afterAll(removeRoots);

/** A bare project directory with `.llmwiki`. */
async function bareRoot(): Promise<string> {
  const root = await tempRoot("llmwiki-barrier-");
  await mkdir(path.join(root, ".llmwiki"));
  return root;
}

describe("a live barrier", () => {
  it("is one JSON line ending in a newline, blocks reads, and only its own token removes it", async () => {
    const root = await bareRoot();
    const token = await publishRetireBarrier(root, "d".repeat(64));
    const text = await readFile(path.join(root, BARRIER), "utf8");
    expect([text.endsWith("}\n"), text.split("\n").length]).toEqual([true, 2]);
    expect(JSON.parse(text)).toMatchObject({ format: "llmwiki-indexed-retire-barrier", version: 1, token, planDigest: "d".repeat(64) });
    expect((await retireBarrierState(root)).kind).toBe("blocking");
    await expect(assertNoLiveRetirement(root)).rejects.toMatchObject({ code: "indexed_retirement_in_progress" });
    await expect(removeRetireBarrier(root, { token: "0".repeat(32) })).rejects.toMatchObject({ code: "indexed_retirement_in_progress" });
    await expect(removeRetireBarrier(root, "stale")).rejects.toMatchObject({ code: "indexed_retirement_in_progress" });
    await removeRetireBarrier(root, { token });
    expect((await retireBarrierState(root)).kind).toBe("absent");
    await assertNoLiveRetirement(root);
  });
});

describe("stale and foreign barriers", () => {
  it("a barrier whose owner exited is stale, blocks nothing and is removed as stale", async () => {
    const root = await bareRoot();
    await ok("barrier", root);
    expect((await retireBarrierState(root)).kind).toBe("stale");
    await assertNoLiveRetirement(root);
    await removeRetireBarrier(root, "stale");
    expect((await retireBarrierState(root)).kind).toBe("absent");
  }, CASE_TIMEOUT_MS);

  it("a barrier naming another host, or one that is not a barrier, blocks", async () => {
    const root = await bareRoot();
    await ok("barrier", root);
    // The owner is gone, but on another host that cannot be known here.
    const stale = JSON.parse(await readFile(path.join(root, BARRIER), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(root, BARRIER), `${JSON.stringify({ ...stale, host: stale.host === "ffffffff" ? "eeeeeeee" : "ffffffff" })}\n`);
    expect((await retireBarrierState(root)).kind).toBe("blocking");
    await writeFile(path.join(root, BARRIER), "{}\n");
    await expect(assertNoLiveRetirement(root)).rejects.toMatchObject({ code: "indexed_retirement_in_progress" });
  }, CASE_TIMEOUT_MS);
});
