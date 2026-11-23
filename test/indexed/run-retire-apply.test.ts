/**
 * @file test/indexed/run-retire-apply.test.ts
 * @description Applying a retirement plan (in a fresh child process): exactly
 * the candidates leave `.llmwiki/indexed`, with their reports; what a new
 * restart would inherit is byte-identical before and after (the retained
 * evidence is exactly the evidence inheritance reads); the last run's report
 * still pages; segment collection stays admissible and an indexed backup
 * succeeds; the same plan cannot be applied twice.
 */

import { cp, lstat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { previewGc } from "../../src/indexed/gc.js";
import type { RunRetireApplyV1 } from "../../src/indexed/run-retire.js";
import { CASE_TIMEOUT_MS, copyOf, ok, runsMode, savedRunsPlan, storeExists, tempRoot, useRunsBase } from "./run-retire-helpers.js";

  // The superseded runs start AFTER the last run, so a new restart inherits their evidence.
const base = useRunsBase({ oldDone: ["done", "none"], last: ["done", "none"], supEmpty: ["superseded", "none"], supPi: ["superseded", "pi"], supIh: ["superseded", "ih"] }, "last");

/** Apply `planFile` to `root` in a child. */
const apply = (root: string, planFile: string) => ok<RunRetireApplyV1>("apply", root, planFile);

describe("apply: what goes and what stays", () => {
  it("retires exactly the candidates and leaves what a restart would inherit unchanged", async () => {
    const project = await copyOf(base());
    const before = await tempRoot("llmwiki-retire-before-");
    await cp(project.root, before, { recursive: true, verbatimSymlinks: true });
    const { planFile } = await savedRunsPlan(project.root, 0);
    const applied = await apply(project.root, planFile);
    expect(applied.retired.map((run) => run.runId).sort()).toEqual([project.ids.oldDone, project.ids.supEmpty].sort());
    for (const name of ["oldDone", "supEmpty"]) expect(await storeExists(project.root, project.ids[name]!)).toBe(false);
    for (const name of ["supPi", "supIh", "last"]) expect(await storeExists(project.root, project.ids[name]!)).toBe(true);
    // Exactly the two kept runs' evidence: one raw intent and one inherited row (distinct fixture slugs).
    const expected = { keys: [`ih:inherited-page\0${"c".repeat(64)}`, `ih:intent-page\0${"a".repeat(64)}`] };
    expect(await ok("inherit", before)).toEqual(expected);
    expect(await ok("inherit", project.root)).toEqual(expected);
  }, CASE_TIMEOUT_MS);

  it("deletes the retired reports, keeps the last run's, and leaves no quarantine or barrier", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    await apply(project.root, planFile);
    expect((await runsMode("report", project.root, project.ids.oldDone!)).outcome).toBe("compile_batch_run_unknown");
    expect(await ok("report", project.root, project.ids.last!)).toEqual({ lines: 0 });
    for (const leaf of ["indexed-retiring", "indexed-retire.json"]) expect(await lstat(path.join(project.root, ".llmwiki", leaf)).catch(() => null)).toBeNull();
  }, CASE_TIMEOUT_MS);
});

describe("apply: the project afterwards", () => {
  it("keeps segment collection admissible and an indexed backup possible", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    await apply(project.root, planFile);
    const gc = await previewGc(project.root);
    expect(gc.admissible, gc.blockers.join("; ")).toBe(true);
    const receipt = await ok<{ stores: number }>("backup", project.root, path.join(await tempRoot("llmwiki-retire-backup-"), "backup"));
    expect(receipt.stores).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);

  it("refuses the same plan twice; a new preview finds nothing more to retire", async () => {
    const project = await copyOf(base());
    const { planFile } = await savedRunsPlan(project.root, 0);
    await apply(project.root, planFile);
    expect((await runsMode("apply", project.root, planFile)).outcome).toBe("indexed_runs_plan_stale");
    const { preview } = await savedRunsPlan(project.root, 0);
    expect([preview.admissible, preview.retirableRuns]).toEqual([true, 0]);
  }, CASE_TIMEOUT_MS);
});
