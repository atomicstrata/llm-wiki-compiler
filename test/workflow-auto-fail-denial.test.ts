/**
 * @file test/workflow-auto-fail-denial.test.ts
 * @description Regression tests for BUG 1 (H2): the auto-fail routing of a
 * HARD-DENIED stage-output submit. The executor REFUSING a write (a trust-gated
 * relation/lifecycle with no grant → `TrustGateRequiresGrantError`, a relation
 * denial → `RelationWriteDeniedError`, an illegal lifecycle transition →
 * `LifecycleTransitionError`, or a page `deny`) is a dead-end for the attempt, so
 * the run is routed to terminal `failed` (retryable via `resume`) rather than left
 * stuck `awaiting-output`. The ORIGINAL denial still propagates to the caller.
 *
 * Contrasting invariant: a STAGED page write (no grant, trust page → `applied:false`,
 * NOT a throw) is NOT a failure — the run stays `awaiting-output` (recoverable).
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { kindsProfile, startKindsRun, citesOutput } from "./fixtures/seam-fixtures.js";
import { buildWorkflowProfile, installWorkflowProfile, experimentPageOutput as pageOutput } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { resumeWorkflow } from "../src/workflows/resume.js";
import { readRun } from "../src/workflows/store.js";
import { TrustGateRequiresGrantError } from "../src/workflows/errors.js";
import { RelationWriteDeniedError } from "../src/trust/relation-apply.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import type { EntityId } from "../src/profile/types.js";

afterEach(() => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
});

/** Stand up a trust-gated kinds project (`papers/a`+`papers/b` draft) and start a run. */
function startKinds(prefix: string): Promise<{ root: string; runId: string }> {
  return startKindsRun(prefix, kindsProfile(["papers"], "trust:high"), ["a", "b"]);
}

describe("auto-fail on a HARD-denied submit — run ends failed (not stuck)", () => {
  it("a trust-gated relation with no grant throws TrustGateRequiresGrantError AND fails the run", async () => {
    const { root, runId } = await startKinds("wf-autofail-trust-");
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    const read = await readRun(root, runId);
    expect(read.status === "ok" && read.run.status).toBe("failed");
    expect(read.status === "ok" && read.run.events.at(-1)).toMatchObject({ type: "run-failed", actorKind: "system" });
  });

  it("records the denial reason in the run-failed event detail", async () => {
    const { root, runId } = await startKinds("wf-autofail-reason-");
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toThrow();
    const read = await readRun(root, runId);
    const detail = read.status === "ok" ? (read.run.events.at(-1) as { detail?: string }).detail : undefined;
    expect(detail).toContain("trust-gated");
  });

  it("auto-projects the FAILED run to its projectionFile AND still propagates the denial", async () => {
    const profile = kindsProfile(["papers"], "trust:high");
    profile.workflows!.build.projectionFile = "wiki/outputs/workflows/build.md";
    const { root, runId } = await startKindsRun("wf-autofail-projection-", profile, ["a", "b"]);
    await expect(submitStageOutput(root, runId, citesOutput())).rejects.toBeInstanceOf(TrustGateRequiresGrantError);
    const md = await readFile(path.join(root, "wiki/outputs/workflows/build.md"), "utf8");
    expect(md).toContain("status: failed"); // the projection reflects the auto-failed run, not stale state
  });

  it("a relation DENY (undeclared type, with grant) fails the run, retryable via resume", async () => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "research-kinds";
    const { root, runId } = await startKinds("wf-autofail-deny-");
    const out: StageOutput = { kind: "relation", input: { type: "nope", from: "papers/a" as EntityId, to: "papers/b" as EntityId, attributes: {} } };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeInstanceOf(RelationWriteDeniedError);
    const failed = await readRun(root, runId);
    expect(failed.status === "ok" && failed.run.status).toBe("failed");
    const resumed = await resumeWorkflow(root, runId);
    expect(resumed.status).toBe("running");
  });
});

describe("a STAGED page submit stays awaiting-output — NOT failed (recoverable)", () => {
  it("a clean trust-page output without the grant stages and leaves the run active", async () => {
    const root = await makeTempRoot("wf-staged-not-failed");
    await installWorkflowProfile(root, buildWorkflowProfile([{ id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" }]));
    const run = await startWorkflow(root, "build", {});
    const result = await submitStageOutput(root, run.runId, pageOutput("alpha"));
    expect(result.applied).toBe(false);
    expect(result.decision).toBe("stage-for-review");
    const read = await readRun(root, run.runId);
    expect(read.status === "ok" && read.run.status).not.toBe("failed");
    const advanced = await advanceWorkflow(root, run.runId);
    expect(advanced.outcome).toBe("awaiting-output");
  });
});
