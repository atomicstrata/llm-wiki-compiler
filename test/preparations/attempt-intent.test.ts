/**
 * @file test/preparations/attempt-intent.test.ts
 * @description Leg C/D contract: intent is sealed and durably recorded (running
 * state, execution owner, running phase summary) BEFORE the leg runs, and the
 * owner is cleared on commit. A phase whose SEALED PLAN phase carries a gate is
 * blocked fail-closed even when the caller supplies no gate (gate is derived from
 * the immutable plan, never the request), and an out-of-bounds index parks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveAttemptId } from "../../src/preparations/ids.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, phaseInstanceIdFor, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";

let staged: StagedPreparation;
beforeEach(async () => { staged = await stagePreparation(); });
afterEach(() => staged.cleanup());

describe("preparation attempt intent", () => {
  it("records running state and the execution owner durably before the leg runs", async () => {
    const request = attemptRequest(staged);
    const attemptId = deriveAttemptId(request.phaseInstanceId, 0);
    const midLeg = async () => {
      const read = await readPreparationRun(staged.root, staged.binding);
      expect(read.status === "ok" && read.run.state).toBe("running");
      expect(read.status === "ok" && read.run.executionOwner?.attemptId).toBe(attemptId);
      return succeededLeg();
    };
    const outcome = await executePhaseAttempt({ ...request, leg: midLeg });
    expect(outcome).toEqual({ status: "committed", attemptId, phaseState: "succeeded" });
  });

  it("clears the execution owner and settles the phase summary on commit", async () => {
    await executePhaseAttempt(attemptRequest(staged));
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error(read.status);
    expect(read.run.executionOwner).toBeUndefined();
    expect(read.run.phaseSummaries[0]?.state).toBe("succeeded");
  });

  it("blocks a plan-gated phase derived from the sealed plan, not the request", async () => {
    const request = attemptRequest(staged, {
      logicalPhaseId: "review", phaseInstanceId: phaseInstanceIdFor(staged.binding, "review"),
    });
    expect(await executePhaseAttempt(request)).toEqual({ status: "blocked", reason: "gate-unresolved" });
  });

  it("parks an attempt index outside the declared phase bounds", async () => {
    const request = attemptRequest(staged, { attemptIndex: 9 });
    expect(await executePhaseAttempt(request)).toEqual({ status: "parked", reason: "attempt-bound-exceeded" });
  });
});
