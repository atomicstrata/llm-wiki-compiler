/**
 * @file test/indexed/run-retire-recovery.test.ts
 * @description Interrupted retirements (a fault injected at each store step,
 * in the applying child) leave consistent, recognisable states that the next
 * apply finishes, and the partial account says exactly what happened: after the
 * receipt but before the commit, nothing is retired and only the receipt is
 * finished; after the commit the run COUNTS as retired (cleanup unfinished), is
 * gone from run discovery, collection stays admissible and a backup works; part
 * way through its cleanup the reclaimed bytes are counted and the rest is
 * finished. A receipt never authorizes cleanup it does not own: a quarantined
 * store that no longer matches it, a store replaced since it was written, or a
 * receipt copied into another project root blocks, and nothing is deleted.
 */

import { cp, lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { previewGc } from "../../src/indexed/gc.js";
import type { RunRetireApplyV1, RunRetireDoneV1, RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import { CASE_TIMEOUT_MS, copyOf, ok, runsMode, savedRunsPlan, storeExists, tempRoot, useRunsBase, type RunsProject } from "./run-retire-helpers.js";

/**
 * The post-commit recovery case also makes a durable backup. Its interrupted
 * apply took about 41 s and backup about 112 s on slow external storage,
 * leaving too little of 180 s for final apply and verification. Give only
 * this longer chain bounded headroom under the explicit slow-storage profile;
 * normal storage and every other case keep the shared original limit.
 */
const BACKUP_RECOVERY_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** The backup-and-recovery case's limit for the explicitly selected profile. */
const backupRecoveryTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? BACKUP_RECOVERY_SLOW_STORAGE_TIMEOUT_MS
  : CASE_TIMEOUT_MS;

  // The finished candidate carries a checkpointed row, so its store holds a segment beside its manifest.
const base = useRunsBase({ last: ["done", "none"], done: ["done", "pi"] }, "last");

/** The quarantine directory's entries (empty when absent). */
const quarantine = (root: string): Promise<string[]> => readdir(path.join(root, ".llmwiki", "indexed-retiring")).catch(() => []);

/** A copy whose one candidate's retirement was interrupted at `step`; returns it with the partial account. */
async function interruptedAt(step: string): Promise<{ project: RunsProject; partial: RunRetireDoneV1 }> {
  const project = await copyOf(base());
  const { planFile } = await savedRunsPlan(project.root, 0);
  const json = await runsMode("apply", project.root, planFile, "fail", step);
  expect(json.outcome).toBe("indexed_runs_partial");
  const partial = json.partial as RunRetireDoneV1;
  expect(partial.interrupted).toBe(`crun-${project.ids.done}`);
  return { project, partial };
}

/** Preview again (one owned cleanup pending) and apply; returns the apply. */
async function finishes(project: RunsProject, retired: number): Promise<RunRetireApplyV1> {
  const { preview, planFile } = await savedRunsPlan(project.root, 0);
  expect([preview.admissible, preview.pendingCleanup, preview.retirableRuns], preview.blockers.join("; ")).toEqual([true, 1, retired]);
  const applied = await ok<RunRetireApplyV1>("apply", project.root, planFile);
  expect([applied.cleaned, applied.retired.length]).toEqual([1, retired]);
  expect(await quarantine(project.root)).toEqual([]);
  return applied;
}

/** Expect a preview to block with `pattern`, an apply of its plan to refuse, and the receipt to stay. */
async function blocksKeepingReceipt(project: RunsProject, pattern: RegExp): Promise<void> {
  const { preview, planFile } = await savedRunsPlan(project.root, 0);
  expect([preview.admissible, preview.blockers.join("; ")]).toEqual([false, expect.stringMatching(pattern)]);
  expect((await runsMode("apply", project.root, planFile)).outcome).toBe("indexed_runs_blocked");
  expect(await quarantine(project.root)).toContain(`crun-${project.ids.done}.receipt.json`);
}

describe("interrupted retirements", () => {
  it("before the commit: nothing is retired, and the next apply drops the receipt and retires it", async () => {
    const { project, partial } = await interruptedAt("receipt");
    expect(partial.retired).toEqual([]);
    expect(await storeExists(project.root, project.ids.done!)).toBe(true);
    expect(await quarantine(project.root)).toEqual([`crun-${project.ids.done}.receipt.json`]);
    await finishes(project, 1);
    expect(await storeExists(project.root, project.ids.done!)).toBe(false);
  }, CASE_TIMEOUT_MS);

  it("after the commit: the run counts as retired, is consistent everywhere, and the next apply finishes its cleanup", async () => {
    const { project, partial } = await interruptedAt("commit");
    expect(partial.retired).toMatchObject([{ runId: project.ids.done, cleanupComplete: false }]);
    expect(partial.reclaimedBytes).toBe(0);
    expect((await ok<{ ids: string[] }>("run-ids", project.root)).ids).toEqual([project.ids.last]);
    const gc = await previewGc(project.root);
    expect(gc.admissible, gc.blockers.join("; ")).toBe(true);
    expect(await ok("backup", project.root, path.join(await tempRoot("llmwiki-retire-backup-"), "backup"))).toMatchObject({ stores: expect.any(Number) });
    expect((await finishes(project, 0)).reclaimedBytes).toBeGreaterThan(0);
  }, backupRecoveryTimeoutMs);

  it("part-way through a store's cleanup: the reclaimed bytes are counted and the next apply finishes the rest", async () => {
    const { project, partial } = await interruptedAt("leaf");
    expect([partial.retired.length, partial.reclaimedBytes > 0]).toEqual([1, true]);
    expect((await readdir(path.join(project.root, ".llmwiki", "indexed-retiring", `crun-${project.ids.done}`))).length).toBeGreaterThan(0);
    await finishes(project, 0);
  }, CASE_TIMEOUT_MS);
});

describe("receipts never authorize what they do not own", () => {
  it("a quarantined store that no longer matches its receipt blocks and is never deleted", async () => {
    const { project } = await interruptedAt("commit");
    const extra = path.join(project.root, ".llmwiki", "indexed-retiring", `crun-${project.ids.done}`, "foreign.txt");
    await writeFile(extra, "not recorded\n");
    await blocksKeepingReceipt(project, /does not match its cleanup receipt/);
    expect(await lstat(extra).then(() => true)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("a store replaced since its receipt was written blocks, and the receipt stays", async () => {
    const { project } = await interruptedAt("receipt");
    const store = path.join(project.root, ".llmwiki", "indexed", `crun-${project.ids.done}`);
    const aside = path.join(await tempRoot("llmwiki-retire-aside-"), "store");
    await cp(store, aside, { recursive: true });
    await rm(store, { recursive: true });
    await rename(aside, store);
    await blocksKeepingReceipt(project, /was replaced since its cleanup receipt was written/);
  }, CASE_TIMEOUT_MS);

  it("a receipt copied into another project root blocks there", async () => {
    const { project } = await interruptedAt("commit");
    const copy = { root: await tempRoot("llmwiki-retire-copy-"), ids: project.ids };
    await cp(project.root, copy.root, { recursive: true, verbatimSymlinks: true });
    const found = await ok<RunRetirePreviewV1>("preview", copy.root, "0");
    expect([found.admissible, found.blockers.join("; ")]).toEqual([false, expect.stringMatching(/belongs to another project root/)]);
    await blocksKeepingReceipt(copy, /belongs to another project root/);
  }, CASE_TIMEOUT_MS);
});
