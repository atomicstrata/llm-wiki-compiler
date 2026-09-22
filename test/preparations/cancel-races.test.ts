/**
 * @file test/preparations/cancel-races.test.ts
 * @description Cancellation races across provider work, custody, and handoff
 * boundaries (design section 23.2). It proves cooperative cancellation during
 * provider work settles the phase `cancelled`; an applied effect settles honestly
 * to `recovery-required` rather than a false cancelled; a late completion after
 * the fence rotated cannot land; a forged file does not cancel a succeeding
 * attempt; and cancellation arriving after the safe boundary never falsely
 * claims cancelled.
 */

import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { parkAttemptForRecoveryLocked } from "../../src/preparations/recovery.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, phaseInstanceIdFor, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";
import { attemptSiblingPhase } from "./cancel-settlement-fixture.js";

const NONCE = "0".repeat(32);
async function readRun(staged: StagedPreparation) {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status !== "ok") throw new Error("run unavailable");
  return read.run;
}

describe("cancellation races", () => {
  let staged: StagedPreparation | undefined;
  afterEach(async () => { await staged?.cleanup(); staged = undefined; });

  it("settles cancelled when the provider leg cooperatively cancels", async () => {
    staged = await stagePreparation();
    const cancelledLeg = async () => ({ ...succeededLeg(), phaseState: "cancelled" as const });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: cancelledLeg }));
    expect(outcome).toMatchObject({ status: "committed", phaseState: "cancelled" });
    expect((await readRun(staged)).phaseSummaries[0]?.state).toBe("cancelled");
  });

  it("settles an applied effect to recovery-required, never a false cancelled", async () => {
    staged = await stagePreparation();
    const effectLeg = async () => ({ ...succeededLeg(), phaseState: "failed" as const, problem: "provider-failed", effects: [{ receipt: { outcome: "applied" } as never, effectIndex: 0 }] });
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: effectLeg }));
    expect(outcome).toMatchObject({ status: "parked", reason: "external-effect-unrecorded" });
    expect((await readRun(staged)).state).toBe("recovery-required");
  });

  it("cannot land a late completion after the fence rotated to recovery-required", async () => {
    staged = await stagePreparation();
    const phaseInstanceId = phaseInstanceIdFor(staged.binding, "collect");
    const lateLeg = async () => {
      await acquireLock(staged!.root, { quiet: true });
      try {
        const run = await readRun(staged!);
        const owner = run.executionOwner!;
        await parkAttemptForRecoveryLocked({ root: staged!.root, binding: staged!.binding, run, phaseInstanceId, attemptId: owner.attemptId, leaseNonce: owner.leaseNonce, principal: { id: "op", surface: "cli" }, at: "2026-07-22T00:00:05.000Z" });
      } finally { await releaseLock(staged!.root); }
      return succeededLeg();
    };
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: lateLeg }));
    expect(outcome.status).toBe("parked");
    expect((await readRun(staged)).state).toBe("recovery-required");
  });

  it("ignores a forged cancel file and lets a valid attempt succeed", async () => {
    staged = await stagePreparation();
    const file = preparationPaths(staged.root, staged.binding.workspaceId).cancelFile(staged.binding.runId);
    await writeFile(file, "not-json", { mode: 0o600 });
    const outcome = await executePhaseAttempt(attemptRequest(staged));
    expect(outcome).toMatchObject({ status: "committed", phaseState: "succeeded" });
  });

  it("keeps cancellation sticky so a re-attempt and a sibling phase both refuse after a committed cancel", async () => {
    staged = await stagePreparation();
    await writePreparationCancelLockFree(staged.root, { workspaceId: staged.binding.workspaceId, runId: staged.binding.runId, requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: NONCE });
    const first = await executePhaseAttempt(attemptRequest(staged, { leg: async () => { throw new Error("leg must not run after cancel"); } }));
    expect(first).toMatchObject({ status: "committed", phaseState: "cancelled" });
    // Effect-free by plan, so the acknowledgement advances to the honest terminal.
    expect((await readRun(staged)).state).toBe("cancelled");
    const reAttempt = await executePhaseAttempt(attemptRequest(staged, { attemptIndex: 1 }));
    expect(reAttempt).toMatchObject({ status: "parked", reason: "run-not-startable-cancelled" });
    const sibling = await attemptSiblingPhase(staged);
    expect(sibling).toMatchObject({ status: "parked", reason: "run-not-startable-cancelled" });
  });

  it("never falsely claims cancelled when cancellation arrives after the safe boundary", async () => {
    staged = await stagePreparation();
    const afterBoundaryLeg = async () => {
      await writePreparationCancelLockFree(staged!.root, { workspaceId: staged!.binding.workspaceId, runId: staged!.binding.runId, requester: "op", at: "2026-07-22T00:00:00.000Z", nonce: NONCE });
      return succeededLeg();
    };
    const outcome = await executePhaseAttempt(attemptRequest(staged, { leg: afterBoundaryLeg }));
    expect(outcome).toMatchObject({ status: "committed", phaseState: "succeeded" });
  });
});
