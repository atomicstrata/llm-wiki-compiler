/**
 * @file test/workflow-run-ownership.test.ts
 * @description ADVERSARIAL run-ownership tests (M1) — BOTH the action surface AND the
 * DIRECT core ops.
 *
 * A run records the advisory `owner` identity that STARTED it. A MUTATING
 * runId-bearing op (advance/cancel/resume/gate) by a DIFFERENT caller is refused with
 * `RunOwnerMismatchError` — enforced by the SHARED `assertRunOwnership` under the
 * lock, so the direct `cancelWorkflow`/`advanceWorkflow` bypass is closed, not just
 * the action surface. The same caller works; an OWNER-LESS (legacy) run is
 * unrestricted; a read-only by-id `status` is NOT owner-gated (cross-owner reads OK).
 * Caller identity is `LLMWIKI_ACTOR` (advisory), driven here per-test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { plantSignedRun } from "./fixtures/run-integrity.js";
import { readOkRun } from "./fixtures/workflow-profile.js";
import { runAction } from "../src/workflows/run-action.js";
import { startWorkflow } from "../src/workflows/start.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { RunOwnerMismatchError } from "../src/workflows/errors.js";
import type { WorkflowRun } from "../src/workflows/types.js";

const ACTOR_ENV = "LLMWIKI_ACTOR";

afterEach(() => {
  delete process.env[ACTOR_ENV];
});

/** Act as `actor` for the duration of `fn` (sets/clears LLMWIKI_ACTOR). */
async function as<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  process.env[ACTOR_ENV] = actor;
  return fn();
}

/** Install the action profile and start a `build` run as `owner`, returning its id. */
async function startOwnedRun(prefix: string, owner: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installRunActionProfile(root);
  const run = await as(owner, () => startWorkflow(root, "build", {}));
  return { root, runId: run.runId };
}

describe("run ownership — mutating ops on the action surface (M1)", () => {
  it("DENIES actor B cancelling actor A's run and leaves it active", async () => {
    const { root, runId } = await startOwnedRun("own-cancel-b", "alice");
    await as("bob", async () => {
      await expect(runAction(root, "build.cancel", { runId }, "cli")).rejects.toBeInstanceOf(RunOwnerMismatchError);
    });
    expect((await readOkRun(root, runId)).status).toBe("pending");
  });

  it("DENIES actor B advancing actor A's run", async () => {
    const { root, runId } = await startOwnedRun("own-advance-b", "alice");
    await as("bob", async () => {
      await expect(runAction(root, "build.advance", { runId }, "cli")).rejects.toBeInstanceOf(RunOwnerMismatchError);
    });
  });

  it("ALLOWS the SAME actor to cancel their own run", async () => {
    const { root, runId } = await startOwnedRun("own-cancel-same", "alice");
    await as("alice", () => runAction(root, "build.cancel", { runId }, "cli"));
    expect((await readOkRun(root, runId)).status).toBe("cancelled");
  });

  it("ALLOWS a mutation on an OWNER-LESS (legacy) run regardless of caller", async () => {
    const root = await makeTempRoot("own-legacy");
    await installRunActionProfile(root);
    const run = await startWorkflow(root, "build", {});
    const { owner: _drop, ...ownerless } = run; // strip owner → legacy/pre-M1 shape
    await plantSignedRun(root, ownerless as WorkflowRun);
    await as("carol", () => runAction(root, "build.cancel", { runId: run.runId }, "cli"));
    expect((await readOkRun(root, run.runId)).status).toBe("cancelled");
  });

  it("does NOT owner-gate a read-only by-id status (cross-owner reads are observability)", async () => {
    const { root, runId } = await startOwnedRun("own-status", "alice");
    const result = await as("bob", () => runAction(root, "build.statusone", { runId }, "cli"));
    expect(Array.isArray(result.result)).toBe(true);
  });
});

describe("run ownership — DIRECT core ops (FIX B: not just the action surface)", () => {
  it("DENIES actor B cancelWorkflow on actor A's run (direct, no action)", async () => {
    const { root, runId } = await startOwnedRun("own-direct-cancel", "alice");
    await as("bob", async () => {
      await expect(cancelWorkflow(root, runId)).rejects.toBeInstanceOf(RunOwnerMismatchError);
    });
    expect((await readOkRun(root, runId)).status).toBe("pending");
  });

  it("DENIES actor B advanceWorkflow on actor A's run (direct, no action)", async () => {
    const { root, runId } = await startOwnedRun("own-direct-advance", "alice");
    await as("bob", async () => {
      await expect(advanceWorkflow(root, runId)).rejects.toBeInstanceOf(RunOwnerMismatchError);
    });
  });

  it("ALLOWS the SAME actor to cancelWorkflow directly", async () => {
    const { root, runId } = await startOwnedRun("own-direct-same", "alice");
    await as("alice", () => cancelWorkflow(root, runId));
    expect((await readOkRun(root, runId)).status).toBe("cancelled");
  });
});
