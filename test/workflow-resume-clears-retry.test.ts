/**
 * @file test/workflow-resume-clears-retry.test.ts
 * @description Regression tests for BUG 2 (H3+M4): `resume` of a `failed` run must
 * CLEAR the retried stage's recorded work so the retry GENUINELY re-executes —
 * never replays a stale applied write, a stale satisfied gate, or a one-time human
 * approval.
 *
 * Three invariants:
 *  - a write-stage with an APPLIED `outputs[run]`, after fail+resume, has its output
 *    GONE; the next `advance` does NOT auto-complete (it re-parks `awaiting-output`,
 *    so the write MUST be re-submitted);
 *  - a gated stage whose gate sits in `satisfiedGates`, after fail+resume, has the
 *    gate REMOVED; `advance` re-parks (the approval must be re-obtained);
 *  - a `pendingOutput` intent for the retried stage is cleared by resume.
 */

import { describe, it, expect, afterEach } from "vitest";
import { startOneStageBuild, experimentPageOutput as pageOutput, readOkRun, expectAdvanceParkedOnRun } from "./fixtures/workflow-profile.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { submitStageOutput } from "../src/workflows/stage-output.js";
import { failWorkflow } from "../src/workflows/fail.js";
import { resumeWorkflow } from "../src/workflows/resume.js";
import { writeRun } from "../src/workflows/store.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** A single write stage (no gate) — a clean page output auto-applies WITH the grant. */
const WRITE_STAGE: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"] };
/** A single trust-gated write stage — its gate is satisfied only by an applied write. */
const TRUST_STAGE: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" };

afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

/** Start a one-stage `build` run with `stage`, granting auto-apply for the project. */
function startGranted(prefix: string, stage: WorkflowStageDef): Promise<{ root: string; runId: string }> {
  process.env[TRUSTED_WRITE_ENV_VAR] = "research";
  return startOneStageBuild(prefix, stage);
}

describe("resume clears the retried stage's stale APPLIED output", () => {
  it("drops outputs[run] so advance re-parks awaiting-output instead of auto-completing", async () => {
    const { root, runId } = await startGranted("wf-resume-clear-output", WRITE_STAGE);
    await submitStageOutput(root, runId, pageOutput("alpha"));
    expect((await readOkRun(root, runId)).outputs.run).toBeDefined();
    await failWorkflow(root, runId, "boom");
    const resumed = await resumeWorkflow(root, runId);
    expect(Object.hasOwn(resumed.outputs, "run")).toBe(false);
    const advanced = await advanceWorkflow(root, runId);
    expect(advanced.outcome).toBe("awaiting-output");
    expect(advanced.run.currentStage).toBe("run");
  });
});

describe("resume clears the retried stage's stale satisfied GATE", () => {
  it("removes the trust gate from satisfiedGates so the approval must be re-obtained", async () => {
    const { root, runId } = await startGranted("wf-resume-clear-gate", TRUST_STAGE);
    await submitStageOutput(root, runId, pageOutput("beta")); // applies live + satisfies trust:high
    expect((await readOkRun(root, runId)).satisfiedGates).toContain("trust:high");
    await failWorkflow(root, runId, "boom");
    const resumed = await resumeWorkflow(root, runId);
    expect(resumed.satisfiedGates).not.toContain("trust:high");
    await expectAdvanceParkedOnRun(root, runId); // the approval must be re-obtained
  });
});

describe("resume clears a pendingOutput intent for the retried stage", () => {
  it("removes run.pendingOutput so a stale crash-intent does not block the retry", async () => {
    const { root, runId } = await startGranted("wf-resume-clear-pending", WRITE_STAGE);
    const run = await readOkRun(root, runId);
    await writeRun(root, { ...run, pendingOutput: { stageId: "run", opId: `${runId}:run:${run.stateVersion}` } });
    await failWorkflow(root, runId, "boom");
    const resumed = await resumeWorkflow(root, runId);
    expect(resumed.pendingOutput).toBeUndefined();
  });
});
