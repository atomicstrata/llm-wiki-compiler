/**
 * @file test/workflow-start-status.test.ts
 * @description Behavioural tests for the start + status run operations.
 *
 * Covers: `startWorkflow` mints + persists a `pending` run pinned to the active
 * def/profile, is lock-guarded (throws {@link LockBusyError} when busy), rejects
 * an undeclared workflow id without writing; `workflowStatus` classifies a fresh
 * run `current`, a removed workflow `historical`, a removed current stage
 * `blocked-by-config`, a changed def (current stage preserved) `needs-adaptation`,
 * surfaces a corrupted run file as a `problem` (never throws), and reports an
 * unknown id as a `problem` (never throws).
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { startWorkflow, UnknownWorkflowError } from "../src/workflows/start.js";
import { workflowStatus } from "../src/workflows/status.js";
import { listRuns } from "../src/workflows/store.js";
import { acquireLock, releaseLock, LockBusyError } from "../src/utils/lock.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { signRun } from "./fixtures/run-integrity.js";
import type { ProfilePack, WorkflowDef } from "../src/profile/types.js";
import type { WorkflowRun } from "../src/workflows/types.js";

/** A valid profile carrying a two-stage `build` workflow over two entity types. */
function profile(workflow?: WorkflowDef): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { ideas: { directory: "wiki/ideas" }, experiments: { directory: "wiki/experiments" } },
    workflows: {
      build: workflow ?? {
        stages: [
          { id: "draft", reads: ["ideas"], writes: ["ideas"] },
          { id: "run", reads: ["ideas"], writes: ["experiments"] },
        ],
      },
    },
  };
}

/** Write `pack` to `<root>/.llmwiki/profile.json`. */
async function writeProfile(root: string, pack: ProfilePack): Promise<void> {
  const filePath = path.join(root, PROFILE_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(pack), "utf8");
}

describe("startWorkflow", () => {
  it("mints + persists a pending run pinned to the active def/profile", async () => {
    const root = await makeTempRoot("wf-start-ok");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", { topic: "x" });
    expect(run.status).toBe("pending");
    expect(run.currentStage).toBe("draft");
    expect(run.knownStageIds).toEqual(["draft", "run"]);
    expect(run.stageLog).toEqual([
      { stageId: "draft", status: "pending" },
      { stageId: "run", status: "pending" },
    ]);
    expect(run.stateVersion).toBe(0);
    expect(run.workflowDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.inputs).toEqual({ topic: "x" });
  });

  it("throws UnknownWorkflowError for an undeclared id and writes nothing", async () => {
    const root = await makeTempRoot("wf-start-unknown");
    await writeProfile(root, profile());
    await expect(startWorkflow(root, "ghost", {})).rejects.toBeInstanceOf(UnknownWorkflowError);
    expect(await listRuns(root)).toEqual({ status: "ok", runIds: [] });
  });

  it("throws LockBusyError after the bounded timeout when the lock stays held", async () => {
    const root = await makeTempRoot("wf-start-busy");
    await writeProfile(root, profile());
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      // Bounded-blocking acquire: it RETRIES then throws after the timeout, not on
      // the first busy attempt — the consistent workflow-op lock contract. (The
      // elapsed-time floor is asserted on the primitive in lock-pid-reuse.test.ts.)
      await expect(startWorkflow(root, "build", {}, undefined, { timeoutMs: 60, intervalMs: 5 })).rejects.toBeInstanceOf(LockBusyError);
    } finally {
      await releaseLock(root);
    }
  });

  it("throws UnknownWorkflowError (not a TypeError) for an Object-prototype id like 'constructor'", async () => {
    const root = await makeTempRoot("wf-start-proto");
    await writeProfile(root, profile());
    await expect(startWorkflow(root, "constructor", {})).rejects.toBeInstanceOf(UnknownWorkflowError);
    expect(await listRuns(root)).toEqual({ status: "ok", runIds: [] });
  });
});

describe("workflowStatus classification", () => {
  it("classifies a just-started run as current", async () => {
    const root = await makeTempRoot("wf-status-current");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    const statuses = await workflowStatus(root, run.runId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].classification).toBe("current");
  });

  it("classifies a run whose workflow was removed as historical", async () => {
    const root = await makeTempRoot("wf-status-historical");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    await writeProfile(root, { ...profile(), workflows: {} });
    const statuses = await workflowStatus(root, run.runId);
    expect(statuses[0].classification).toBe("historical");
  });

  it("classifies a run whose current stage was removed as blocked-by-config", async () => {
    const root = await makeTempRoot("wf-status-blocked");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    await writeProfile(root, profile({ stages: [{ id: "run", reads: ["ideas"], writes: ["experiments"] }] }));
    const statuses = await workflowStatus(root, run.runId);
    expect(statuses[0].classification).toBe("blocked-by-config");
  });

  /** Start a `build` run, re-install the def with `nextStages`, return the run's classification. */
  async function classifyAfterDefChange(prefix: string, nextStages: WorkflowDef["stages"]): Promise<string> {
    const root = await makeTempRoot(prefix);
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    await writeProfile(root, profile({ stages: nextStages }));
    const statuses = await workflowStatus(root, run.runId);
    return statuses[0].classification;
  }

  it("classifies a changed def whose current stage survives as needs-adaptation", async () => {
    const classification = await classifyAfterDefChange("wf-status-adapt", [
      { id: "draft", reads: ["ideas"], writes: ["experiments"] },
      { id: "run", reads: ["ideas"], writes: ["experiments"] },
    ]);
    expect(classification).toBe("needs-adaptation");
  });

  it("classifies a run on a RENAMED current stage (mapped via previousIds) as needs-adaptation", async () => {
    const classification = await classifyAfterDefChange("wf-status-renamed", [
      { id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["draft"] },
      { id: "run", reads: ["ideas"], writes: ["experiments"] },
    ]);
    expect(classification).toBe("needs-adaptation");
  });
});

describe("workflowStatus fail-closed surfacing", () => {
  it("surfaces a corrupted run file as a problem (never throws)", async () => {
    const root = await makeTempRoot("wf-status-corrupt");
    await writeProfile(root, profile());
    const run = await startWorkflow(root, "build", {});
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${run.runId}.json`);
    await writeFile(leaf, "{ not json", "utf8");
    const statuses = await workflowStatus(root, run.runId);
    expect(statuses[0].classification).toBe("blocked-by-config");
    expect(statuses[0].problem).toBeDefined();
    expect(statuses[0].run).toBeUndefined();
  });

  it("reports an unknown run id as a problem (never throws)", async () => {
    const root = await makeTempRoot("wf-status-unknown");
    await writeProfile(root, profile());
    const statuses = await workflowStatus(root, "build-2026-01-01-9999");
    expect(statuses).toHaveLength(1);
    expect(statuses[0].classification).toBe("blocked-by-config");
    expect(statuses[0].problem).toBeDefined();
  });

  it("classifies a forged run whose workflowId is 'constructor' without throwing", async () => {
    const root = await makeTempRoot("wf-status-proto");
    await writeProfile(root, profile());
    const seed = await startWorkflow(root, "build", {});
    const forged = await signRun(root, { ...seed, workflowId: "constructor" } as WorkflowRun);
    const leaf = path.join(root, ".llmwiki", "workflows", "runs", `${seed.runId}.json`);
    await writeFile(leaf, JSON.stringify(forged), "utf8");
    const statuses = await workflowStatus(root, seed.runId);
    expect(statuses[0].classification).toBe("historical");
  });
});
