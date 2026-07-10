/**
 * @file test/workflow-trust-gate-staging.test.ts
 * @description Regression tests for the trust-gate SAFETY fix (C3): a `trust:`-gated
 * stage's clean page output is ROUTED TO REVIEW (STAGED, gate NOT satisfied) by
 * DEFAULT, and only AUTO-APPLIES + satisfies the gate when the operator grants the
 * project via the out-of-band `LLMWIKI_TRUSTED_WRITE` env var.
 *
 * This kills the "well-formed markdown ⇒ live ⇒ trust gate auto-satisfied" exploit:
 * a clean, in-scope, non-colliding page output is a bare `allow` decision, which
 * USED to apply live and satisfy the trust gate. Now, without the operator grant,
 * such an output STAGES (nothing live in `wiki/`, gate unsatisfied, `advance` does
 * NOT complete the stage).
 */

import { describe, it, expect, afterEach } from "vitest";
import { stat } from "node:fs/promises";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  experimentPageOutput as pageOutput,
  experimentPagePath as experimentPath,
} from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { submitStageOutput } from "../src/workflows/stage-output.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** A single `trust:`-gated write stage (the gated-write seam under test). */
const TRUST_STAGE: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" };

/** Start a `build` run whose single current stage is the trust-gated stage. */
async function startTrust(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([TRUST_STAGE]));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

describe("trust gate — clean output STAGES by default (the exploit is dead)", () => {
  it("a clean page output WITHOUT the grant stages: not live, gate NOT satisfied", async () => {
    const { root, runId } = await startTrust("wf-trust-default");
    const result = await submitStageOutput(root, runId, pageOutput("alpha"));
    expect(result.applied).toBe(false);
    expect(result.decision).toBe("stage-for-review");
    await expect(stat(experimentPath(root, "alpha"))).rejects.toThrow();
    expect(result.run.satisfiedGates).not.toContain("trust:high");
  });

  it("advance does NOT complete a trust-gated stage after a default (staged) submit", async () => {
    const { root, runId } = await startTrust("wf-trust-default-advance");
    await submitStageOutput(root, runId, pageOutput("beta"));
    const advanced = await advanceWorkflow(root, runId);
    expect(advanced.outcome).not.toBe("completed");
    expect(advanced.run.currentStage).toBe("run");
  });
});

describe("trust gate — operator grant AUTO-APPLIES + satisfies", () => {
  it("WITH LLMWIKI_TRUSTED_WRITE granting the project, a clean output applies live + satisfies", async () => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "research";
    const { root, runId } = await startTrust("wf-trust-granted");
    const result = await submitStageOutput(root, runId, pageOutput("gamma"));
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("allow");
    expect((await stat(experimentPath(root, "gamma"))).isFile()).toBe(true);
    expect(result.run.satisfiedGates).toContain("trust:high");
  });

  it("a wildcard '*' grant also auto-applies the trust-gated write", async () => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "*";
    const { root, runId } = await startTrust("wf-trust-wildcard");
    const result = await submitStageOutput(root, runId, pageOutput("delta"));
    expect(result.applied).toBe(true);
    expect(result.run.satisfiedGates).toContain("trust:high");
  });

  it("a grant for a DIFFERENT project does NOT auto-apply (stays staged)", async () => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "some-other-project";
    const { root, runId } = await startTrust("wf-trust-other");
    const result = await submitStageOutput(root, runId, pageOutput("epsilon"));
    expect(result.applied).toBe(false);
    expect(result.run.satisfiedGates).not.toContain("trust:high");
  });
});

describe("trust gate — park then grant then re-submit recovers the SAME run", () => {
  it("a parked run applies on a re-submit after the grant is set (the park is not a dead end)", async () => {
    const { root, runId } = await startTrust("wf-trust-recover");
    // 1. Park: submit without the grant — staged, not live, gate unsatisfied.
    const parked = await submitStageOutput(root, runId, pageOutput("zeta"));
    expect(parked.applied).toBe(false);
    await expect(stat(experimentPath(root, "zeta"))).rejects.toThrow();

    // 2. Grant, then RE-SUBMIT the same run — the staged park left no applied
    // output/pending marker, so the idempotency gate lets the re-submit through.
    process.env[TRUSTED_WRITE_ENV_VAR] = "research";
    const applied = await submitStageOutput(root, runId, pageOutput("zeta"));
    expect(applied.applied).toBe(true);
    expect(applied.run.satisfiedGates).toContain("trust:high");
    expect((await stat(experimentPath(root, "zeta"))).isFile()).toBe(true);

    // 3. The run can now leave the stage.
    const advanced = await advanceWorkflow(root, runId);
    expect(advanced.outcome).toBe("completed");
  });
});
