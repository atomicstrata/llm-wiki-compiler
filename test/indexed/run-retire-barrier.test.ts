/**
 * @file test/indexed/run-retire-barrier.test.ts
 * @description The retirement BARRIER against reader races, with real
 * processes: a reader registered before the barrier is in the census and the
 * apply refuses, changing nothing and removing its barrier; a read in another
 * process while the barrier is published refuses `indexed_retirement_in_progress`;
 * an independent read in the retiring process itself refuses; a live or
 * unreadable barrier refuses reads and keeps the preview inadmissible; a stale
 * barrier (its owner gone) blocks nothing and the next apply removes it. Every
 * long-lived child is owned by `withChild` (released and awaited on every exit).
 */

import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { waitFor } from "./gc-helpers.js";
import {
  CASE_TIMEOUT_MS, copyOf, FINISHED_RUNS, indexedTree, ok, runsMode, savedRunsPlan, tempRoot, useRunsBase, withChild, type RunsProject,
} from "./run-retire-helpers.js";

const base = useRunsBase(FINISHED_RUNS, "last");

/** A ready file and a go file for one hand-off with a child. */
async function syncFiles(): Promise<{ ready: string; go: string }> {
  const dir = await tempRoot("llmwiki-retire-sync-");
  return { ready: path.join(dir, "ready"), go: path.join(dir, "go") };
}

/** The outcome of a child report read of the last run. */
async function reportOutcome(project: RunsProject): Promise<unknown> {
  return (await runsMode("report", project.root, project.ids.last!)).outcome;
}

/** Whether the barrier leaf exists. */
const barrierPresent = (root: string): Promise<boolean> => lstat(path.join(root, ".llmwiki", "indexed-retire.json")).then(() => true, () => false);

describe("readers and the barrier", () => {
  it("refuses while a reader registered before the barrier holds a snapshot, changing nothing", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    const { ready, go } = await syncFiles();
    await withChild(["hold", project.root, project.ids.oldDone!, ready, go], go, async (held) => {
      await waitFor(ready);
      const before = await indexedTree(project.root);
      expect((await runsMode("apply", project.root, planFile)).outcome).toBe("indexed_runs_readers_active");
      expect(await indexedTree(project.root)).toEqual(before);
      await writeFile(go, "go");
      expect((await held).json?.outcome).toBe("ok");
    });
  }, CASE_TIMEOUT_MS);

  it("refuses a read in another process while the barrier is published, then serves it after", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    const { ready, go } = await syncFiles();
    await withChild(["apply", project.root, planFile, "pause", ready, go], go, async (applying) => {
      await waitFor(ready);
      expect(await reportOutcome(project)).toBe("indexed_retirement_in_progress");
      await writeFile(go, "go");
      expect((await applying).json?.outcome).toBe("ok");
    });
    expect([await reportOutcome(project), await barrierPresent(project.root)]).toEqual(["ok", false]);
  }, CASE_TIMEOUT_MS);

  it("refuses an independent read in the retiring process itself", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    const applied = await ok<{ concurrentRead: string; retired: unknown[] }>("apply", project.root, planFile, "read", project.ids.last!);
    expect([applied.concurrentRead, applied.retired.length]).toEqual(["indexed_reader_lease_unavailable", 2]);
  }, CASE_TIMEOUT_MS);
});

describe("live, unreadable and stale barriers", () => {
  it("a live barrier refuses reads and keeps the preview inadmissible until its owner ends", async () => {
    const project = await copyOf(base());
    const { ready, go } = await syncFiles();
    await withChild(["barrier", project.root, ready, go], go, async (owner) => {
      await waitFor(ready);
      expect(await reportOutcome(project)).toBe("indexed_retirement_in_progress");
      const preview = await ok<RunRetirePreviewV1>("preview", project.root, "0");
      expect([preview.admissible, preview.blockers.join("; ")]).toEqual([false, expect.stringMatching(/retirement or scale-down holds/)]);
      await writeFile(go, "go");
      expect((await owner).json?.outcome).toBe("ok");
    });
    expect(await reportOutcome(project)).toBe("ok");
  }, CASE_TIMEOUT_MS);

  it("an unreadable barrier refuses reads and the preview", async () => {
    const project = await copyOf(base());
    await writeFile(path.join(project.root, ".llmwiki", "indexed-retire.json"), "not a barrier\n");
    expect(await reportOutcome(project)).toBe("indexed_retirement_in_progress");
    expect((await ok<RunRetirePreviewV1>("preview", project.root, "0")).admissible).toBe(false);
  }, CASE_TIMEOUT_MS);

  it("a stale barrier blocks nothing, and the next apply removes it", async () => {
    const project = await copyOf(base());
    await ok("barrier", project.root);
    expect(await reportOutcome(project)).toBe("ok");
    const { preview, planFile } = await savedRunsPlan(project.root, 0);
    expect(preview.admissible, preview.blockers.join("; ")).toBe(true);
    expect((await ok<{ retired: unknown[] }>("apply", project.root, planFile)).retired.length).toBe(2);
    expect(await barrierPresent(project.root)).toBe(false);
  }, CASE_TIMEOUT_MS);
});
