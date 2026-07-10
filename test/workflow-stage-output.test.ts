/**
 * @file test/workflow-stage-output.test.ts
 * @description Behavioural tests for `submitStageOutput` — the scope-gated PAGE
 * stage-output submission that wires the workflow harness into the planner→
 * executor seam.
 *
 * Covers the security crux (the WRITES scope guard), the apply path (in-scope
 * `allow` write lands live, records a `stage-output` event, satisfies the stage's
 * `trust:` gate), the staged path (a collision composes `stage-for-review` under
 * the forced `reviewRouted:true`, so nothing lands and no gate is satisfied), and
 * the fail-closed guards (no-writes stage, unsupported output kind, terminal/
 * absent run, lock contention).
 *
 * DECISIONS EXERCISED: `allow` (clean in-scope create) and `stage-for-review` (a
 * pre-existing target trips the create-only collision block; with the forced
 * `reviewRouted:true` that block routes to stage-for-review, never `deny`). The
 * `deny` and `quarantine` branches of `submitStageOutput` are UNREACHABLE through
 * this entry point: it hard-codes `reviewRouted:true` (so a non-quarantine block
 * routes to `stage-for-review`, not `deny`) and the mandatory page checks never
 * request quarantine. Those branches are defensive; they are not force-testable
 * via this seam without a contrived check, so they are noted rather than covered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import {
  RunUnavailableError,
  RunNotActiveError,
  StageWriteScopeError,
  StageHasNoWritesError,
} from "../src/workflows/errors.js";
import { readRun } from "../src/workflows/store.js";
import { acquireLock, releaseLock, LockBusyError } from "../src/utils/lock.js";
import type { WorkflowStageDef } from "../src/profile/types.js";

/** A page output naming `experiments/<slug>` with a minimal valid body. */
function pageOutput(slug: string): StageOutput {
  return { kind: "page", entityType: "experiments", slug, body: `---\ntitle: ${slug}\n---\nbody` };
}

/** Absolute path the planner derives for an `experiments` entity page. */
function experimentPath(root: string, slug: string): string {
  return path.join(root, "wiki", "experiments", `${slug}.md`);
}

/** Start a `build` run whose single current stage is `stage`. */
async function startWith(prefix: string, stage: WorkflowStageDef) {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile([stage]));
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId };
}

describe("submitStageOutput — in-scope apply", () => {
  const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" };

  // The apply path of a `trust:`-gated stage requires the operator's out-of-band
  // trusted-write grant (C3); without it a clean write STAGES (see
  // workflow-trust-gate-staging.test.ts). The fixture profileId is "research".
  beforeEach(() => {
    process.env[TRUSTED_WRITE_ENV_VAR] = "research";
  });
  afterEach(() => {
    delete process.env[TRUSTED_WRITE_ENV_VAR];
  });

  it("applies an in-scope page output, records an event, and satisfies the trust gate", async () => {
    const { root, runId } = await startWith("wf-out-allow", stage);
    const result = await submitStageOutput(root, runId, pageOutput("alpha"));
    expect(result.applied).toBe(true);
    expect(result.decision).toBe("allow");
    expect((await stat(experimentPath(root, "alpha"))).isFile()).toBe(true);
    expect(result.run.events.filter((e) => e.type === "stage-output")).toHaveLength(1);
    expect(result.run.satisfiedGates).toContain("trust:high");
  });

  it("records the applied output under run.outputs keyed by stage id", async () => {
    const { root, runId } = await startWith("wf-out-record", stage);
    const result = await submitStageOutput(root, runId, pageOutput("beta"));
    expect(result.run.outputs.run).toMatchObject({ entityType: "experiments", slug: "beta", decision: "allow" });
  });
});

describe("submitStageOutput — scope guard (the security crux)", () => {
  it("refuses an out-of-scope entityType and leaves the run byte-unchanged", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["ideas"] };
    const { root, runId } = await startWith("wf-out-scope", stage);
    const before = await readRun(root, runId);
    await expect(submitStageOutput(root, runId, pageOutput("nope"))).rejects.toBeInstanceOf(StageWriteScopeError);
    const after = await readRun(root, runId);
    expect(after).toEqual(before);
    await expect(stat(experimentPath(root, "nope"))).rejects.toThrow();
  });

  it("refuses a slug-with-traversal output by scope before any planning when out of scope", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["ideas"] };
    const { root, runId } = await startWith("wf-out-scope-traversal", stage);
    const out: StageOutput = { kind: "page", entityType: "experiments", slug: "../escape", body: "x" };
    await expect(submitStageOutput(root, runId, out)).rejects.toBeInstanceOf(StageWriteScopeError);
  });
});

describe("submitStageOutput — staged (stage-for-review) does not land", () => {
  it("stages a colliding write for review: not live, gate unsatisfied", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "trust:high" };
    const { root, runId } = await startWith("wf-out-staged", stage);
    await mkdir(path.dirname(experimentPath(root, "dup")), { recursive: true });
    await writeFile(experimentPath(root, "dup"), "pre-existing", "utf8");
    const result = await submitStageOutput(root, runId, pageOutput("dup"));
    expect(result.applied).toBe(false);
    expect(result.decision).toBe("stage-for-review");
    expect(await readFile(experimentPath(root, "dup"), "utf8")).toBe("pre-existing");
    expect(result.run.satisfiedGates).not.toContain("trust:high");
    expect(result.run.events.filter((e) => e.type === "stage-output")).toHaveLength(1);
  });
});

describe("submitStageOutput — fail-closed guards", () => {
  it("throws StageHasNoWritesError on a no-writes stage", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: [] };
    const { root, runId } = await startWith("wf-out-nowrites", stage);
    await expect(submitStageOutput(root, runId, pageOutput("x"))).rejects.toBeInstanceOf(StageHasNoWritesError);
  });

  it("throws RunNotActiveError on a terminal (cancelled) run", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"] };
    const { root, runId } = await startWith("wf-out-terminal", stage);
    await cancelWorkflow(root, runId);
    await expect(submitStageOutput(root, runId, pageOutput("x"))).rejects.toBeInstanceOf(RunNotActiveError);
  });

  it("throws RunUnavailableError for an absent run id", async () => {
    const root = await makeTempRoot("wf-out-absent");
    await installWorkflowProfile(root, buildWorkflowProfile([{ id: "run", reads: [], writes: ["experiments"] }]));
    await expect(submitStageOutput(root, "build-2026-01-01-9999", pageOutput("x"))).rejects.toBeInstanceOf(
      RunUnavailableError,
    );
  });

  it("throws LockBusyError when the project lock is already held", async () => {
    const stage: WorkflowStageDef = { id: "run", reads: ["ideas"], writes: ["experiments"] };
    const { root, runId } = await startWith("wf-out-busy", stage);
    expect(await acquireLock(root, { quiet: true })).toBe(true);
    try {
      await expect(
        submitStageOutput(root, runId, pageOutput("x"), { lockOptions: { timeoutMs: 50, intervalMs: 10 } }),
      ).rejects.toBeInstanceOf(LockBusyError);
    } finally {
      await releaseLock(root);
    }
  });
});
