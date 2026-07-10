/**
 * @file test/workflow-stage-output-idempotent.test.ts
 * @description Regression tests for stage-output IDEMPOTENCY (the torn/duplicate
 * external-write bug).
 *
 * A stage produces its output AT MOST ONCE. Two defects this file pins:
 *  - DUPLICATE: re-submitting an already-applied stage must be REFUSED
 *    ({@link StageOutputAlreadyAppliedError}) with NO second external page created
 *    (the wiki dir holds exactly ONE page).
 *  - ORPHAN: a submit persists a `pendingOutput` INTENT marker BEFORE the external
 *    apply and CLEARS it in the record-output write. A submit that finds a
 *    `pendingOutput` for the current stage (a prior submit crashed mid-apply)
 *    FAILS CLOSED ({@link StageOutputPendingError}) — never silently re-applies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile, readOkRun } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import {
  StageOutputAlreadyAppliedError,
  StageOutputPendingError,
} from "../src/workflows/errors.js";
import { writeRun } from "../src/workflows/store.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import type { WorkflowStageDef } from "../src/profile/types.js";
import type { WorkflowRun } from "../src/workflows/types.js";

const STAGE: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" };

// These idempotency tests exercise the APPLY path of a `trust:`-gated stage, which
// (C3) requires the operator's out-of-band trusted-write grant for the fixture
// project (profileId "research"); without it a clean write STAGES instead.
beforeEach(() => {
  process.env[TRUSTED_WRITE_ENV_VAR] = "research";
});
afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

/** A page output naming `experiments/<slug>` with a minimal valid body. */
function pageOutput(slug: string): StageOutput {
  return { kind: "page", entityType: "experiments", slug, body: `---\ntitle: ${slug}\n---\nbody` };
}

/** The `experiments` wiki directory where applied page outputs land. */
function experimentsDir(root: string): string {
  return path.join(root, "wiki", "experiments");
}

/** Start a `build` run whose single current stage is {@link STAGE}. */
async function startWith(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([STAGE]));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

describe("submitStageOutput — applied-once (no duplicate external write)", () => {
  it("re-submitting an applied stage throws and creates NO second page", async () => {
    const { root, runId } = await startWith("wf-idem-dup");
    await submitStageOutput(root, runId, pageOutput("alpha"));
    expect((await readdir(experimentsDir(root))).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    await expect(submitStageOutput(root, runId, pageOutput("alpha"))).rejects.toBeInstanceOf(
      StageOutputAlreadyAppliedError,
    );
    // The whole point: still exactly ONE page, no duplicate live write.
    expect((await readdir(experimentsDir(root))).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  });

  it("a clean submit records the output and leaves pendingOutput ABSENT", async () => {
    const { root, runId } = await startWith("wf-idem-clear");
    const result = await submitStageOutput(root, runId, pageOutput("beta"));
    expect(result.run.outputs.run).toBeDefined();
    expect(result.run.pendingOutput).toBeUndefined();
    expect((await readOkRun(root, runId)).pendingOutput).toBeUndefined();
  });
});

describe("submitStageOutput — crash mid-apply fails closed", () => {
  it("a pendingOutput for the current stage throws StageOutputPendingError, no new write", async () => {
    const { root, runId } = await startWith("wf-idem-pending");
    const base = await readOkRun(root, runId);
    // Simulate a crash mid-apply: intent persisted, output NOT recorded.
    const crashed: WorkflowRun = { ...base, pendingOutput: { stageId: "run", opId: `${runId}:run:0` } };
    await writeRun(root, crashed);

    await expect(submitStageOutput(root, runId, pageOutput("gamma"))).rejects.toBeInstanceOf(
      StageOutputPendingError,
    );
    // Fail closed: no external page written by the refused re-apply.
    await expect(stat(path.join(experimentsDir(root), "gamma.md"))).rejects.toThrow();
    expect((await readOkRun(root, runId)).pendingOutput).toEqual({ stageId: "run", opId: `${runId}:run:0` });
  });
});
