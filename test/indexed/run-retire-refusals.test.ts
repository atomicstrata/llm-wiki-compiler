/**
 * @file test/indexed/run-retire-refusals.test.ts
 * @description Every retirement refusal changes nothing (the indexed,
 * quarantine, barrier and pin trees are identical before and after): a plan
 * without the offline assertion, a malformed plan, a FORGED plan naming a kept
 * run, a plan made stale by a new run, a pin, the compile state or a touched
 * leaf; an apply from a process that already read the stores; a store holding
 * a leaf this build never deletes (kept, never removed); an unowned quarantine
 * entry, a malformed run manifest and a store named like a run store that is
 * not one (blockers).
 */

import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { applyRunRetirement, type RunRetirePlanV1, type RunRetirePreviewV1 } from "../../src/indexed/run-retire.js";
import {
  CASE_TIMEOUT_MS, classes, copyOf, FINISHED_RUNS, indexedTree, ok, runsMode, savedRunsPlan, useRunsBase, writePlan, type RunsProject,
} from "./run-retire-helpers.js";

const base = useRunsBase(FINISHED_RUNS, "last");

/** A fresh copy and its saved plan (keeping nothing for reports). */
async function planned(): Promise<{ project: RunsProject; plan: RunRetirePlanV1; planFile: string }> {
  const project = await copyOf(base());
  const { preview, planFile } = await savedRunsPlan(project.root, 0);
  expect(preview.retirableRuns).toBe(2);
  return { project, plan: preview.plan, planFile };
}

/** Expect a child apply of `planFile` to refuse with `code` and change nothing. */
async function expectRefusal(root: string, planFile: string, code: string): Promise<void> {
  const before = await indexedTree(root);
  expect((await runsMode("apply", root, planFile)).outcome).toBe(code);
  expect(await indexedTree(root)).toEqual(before);
}

/** The path of run `runId`'s store under `root`. */
const storeDir = (root: string, runId: string): string => path.join(root, ".llmwiki", "indexed", `crun-${runId}`);

describe("plans", () => {
  it("refuses without the offline assertion and refuses malformed plans, before reading anything", async () => {
    const { project, plan } = await planned();
    await expect(applyRunRetirement(project.root, plan, {})).rejects.toMatchObject({ code: "indexed_runs_offline_unconfirmed" });
    const malformed: unknown[] = [{ ...plan, extra: 1 }, { ...plan, format: "other" }, { ...plan, keepFinished: 5_000 }, { ...plan, candidates: [plan.candidates[0], plan.candidates[0]] },
      { ...plan, candidates: [{ ...plan.candidates[0], store: "cstate" }] }, null, []];
    for (const value of malformed) await expect(applyRunRetirement(project.root, value, { readersOffline: true })).rejects.toMatchObject({ code: "indexed_runs_plan_invalid" });
  }, CASE_TIMEOUT_MS);

  it("refuses a forged plan naming the last run", async () => {
    const { project, plan } = await planned();
    const forged = { ...plan, candidates: [...plan.candidates, { ...plan.candidates[0]!, store: `crun-${project.ids.last}` }] };
    await expectRefusal(project.root, await writePlan(project.root, forged), "indexed_runs_plan_stale");
  }, CASE_TIMEOUT_MS);

  it("refuses a plan made stale by a new run, a pin or the compile state", async () => {
    for (const change of [["run", "done", "none"], ["pin", "late-pin"], ["last-run", "null"]]) {
      const { project, planFile } = await planned();
      await ok(change[0]!, project.root, ...change.slice(1));
      await expectRefusal(project.root, planFile, "indexed_runs_plan_stale");
    }
  }, CASE_TIMEOUT_MS);

  it("refuses a plan made stale by a touched candidate leaf", async () => {
    const { project, planFile } = await planned();
    await utimes(path.join(storeDir(project.root, project.ids.oldDone!), "manifest.json"), new Date(), new Date(Date.now() - 60_000));
    await expectRefusal(project.root, planFile, "indexed_runs_plan_stale");
  }, CASE_TIMEOUT_MS);

  it("refuses an apply from a process that already read the stores", async () => {
    const project = await copyOf(base());
    const before = await indexedTree(project.root);
    expect((await runsMode("preview-apply", project.root)).outcome).toBe("indexed_reader_lease_unavailable");
    expect(await indexedTree(project.root)).toEqual(before);
  }, CASE_TIMEOUT_MS);
});

describe("stores and quarantine", () => {
  it("keeps a run whose store holds a leaf a retirement never deletes", async () => {
    const project = await copyOf(base());
    await writeFile(path.join(storeDir(project.root, project.ids.oldDone!), "notes.txt"), "not ours\n");
    const found = await ok<RunRetirePreviewV1>("preview", project.root, "0");
    expect(found.admissible).toBe(true);
    expect(classes(found, project.ids).oldDone).toBe("unremovable");
  }, CASE_TIMEOUT_MS);

  it("blocks on an unowned quarantine entry and on a malformed run manifest, deleting nothing", async () => {
    const { project, planFile } = await planned();
    await mkdir(path.join(project.root, ".llmwiki", "indexed-retiring", `crun-${"0".repeat(12)}`), { recursive: true });
    await expectRefusal(project.root, planFile, "indexed_runs_blocked");
    const second = await planned();
    await writeFile(path.join(storeDir(second.project.root, second.project.ids.newDone!), "manifest.json"), "{}\n");
    await expectRefusal(second.project.root, second.planFile, "indexed_runs_blocked");
  }, CASE_TIMEOUT_MS);

  it("blocks on a store named like a run store that is not one", async () => {
    const { project, planFile } = await planned();
    await mkdir(path.join(project.root, ".llmwiki", "indexed", "crun-misnamed"));
    const found = await ok<RunRetirePreviewV1>("preview", project.root, "0");
    expect([found.admissible, found.blockers.join("; ")]).toEqual([false, expect.stringMatching(/named like a batch run store/)]);
    await expectRefusal(project.root, planFile, "indexed_runs_blocked");
  }, CASE_TIMEOUT_MS);
});
