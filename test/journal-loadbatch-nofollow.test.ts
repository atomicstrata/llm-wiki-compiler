/**
 * @file Confinement regression for the journal storage READ path. The write side
 * persists batches through the no-follow hardened `atomicWrite`; the read side
 * (`loadBatch` → `readOrNull`) must match it and refuse a symlinked journal leaf.
 *
 * Otherwise a planted `.llmwiki/journal/<id>.json` symlink pointing out of tree is
 * followed, and its out-of-tree bytes are parsed as a batch — which journal replay
 * would then execute (writing attacker pre-state content to confined in-root
 * targets). A symlinked leaf must read as "not loadable" (null), never followed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { loadBatch } from "../src/trust/journal.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A structurally-valid batch JSON (so the ONLY thing stopping the read is no-follow). */
const FORGED_BATCH = JSON.stringify({ batchId: "forged", status: "committed", entries: [] });

describe("journal loadBatch refuses a symlinked storage leaf", () => {
  it("does not follow a symlinked journal file out of tree", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "journal-nofollow-"));
    await mkdir(path.join(dir, ".llmwiki/journal"), { recursive: true });
    const outOfTree = path.join(dir, "outside.json");
    await writeFile(outOfTree, FORGED_BATCH, "utf8");
    await symlink(outOfTree, path.join(dir, ".llmwiki/journal/forged.json"));

    expect(await loadBatch(dir, "forged")).toBeNull();
  });

  it("still loads a real in-tree journal file (no over-correction)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "journal-nofollow-ok-"));
    await mkdir(path.join(dir, ".llmwiki/journal"), { recursive: true });
    await writeFile(path.join(dir, ".llmwiki/journal/real.json"), FORGED_BATCH, "utf8");

    const batch = await loadBatch(dir, "real");
    expect(batch?.status).toBe("committed");
  });
});
