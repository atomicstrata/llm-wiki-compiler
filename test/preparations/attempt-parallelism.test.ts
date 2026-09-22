/**
 * @file test/preparations/attempt-parallelism.test.ts
 * @description Parallelism and identity contract (design sections 15.5, 16.5).
 * Independent preparations execute attempts concurrently outside the lock and
 * both commit; a capacity/lock race on ONE run produces exactly one winner and a
 * typed refusal, never a second unrecorded attempt (the run's single execution
 * owner is the fence). Attempt and broker-request identities are deterministic
 * and distinct, so two attempts can never race the same effect identity.
 */

import { afterEach, describe, expect, it } from "vitest";
import { deriveAttemptId, deriveBrokerRequestId } from "../../src/preparations/ids.js";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { attemptRequest, stagePreparation, type StagedPreparation } from "./attempt-fixture.js";

const staged: StagedPreparation[] = [];
async function stage(): Promise<StagedPreparation> { const s = await stagePreparation(); staged.push(s); return s; }
afterEach(async () => { await Promise.all(staged.splice(0).map((s) => s.cleanup())); });

describe("preparation attempt parallelism", () => {
  it("commits independent attempts on separate runs concurrently", async () => {
    const [a, b] = await Promise.all([stage(), stage()]);
    const [outA, outB] = await Promise.all([
      executePhaseAttempt(attemptRequest(a)), executePhaseAttempt(attemptRequest(b)),
    ]);
    expect(outA.status).toBe("committed");
    expect(outB.status).toBe("committed");
    expect(outA.status === "committed" && outA.attemptId).not.toBe(outB.status === "committed" && outB.attemptId);
  });

  it("produces exactly one winner when two attempts race the same phase", async () => {
    const s = await stage();
    const outcomes = await Promise.all([
      executePhaseAttempt(attemptRequest(s)), executePhaseAttempt(attemptRequest(s)),
    ]);
    expect(outcomes.filter((o) => o.status === "committed")).toHaveLength(1);
    expect(outcomes.some((o) => o.status === "refused-busy" || o.status === "parked")).toBe(true);
  });

  it("derives deterministic, distinct attempt and broker-request identities", async () => {
    const s = await stage();
    const phase = attemptRequest(s).phaseInstanceId;
    const first = deriveAttemptId(phase, 0);
    expect(deriveAttemptId(phase, 0)).toBe(first);
    expect(deriveAttemptId(phase, 1)).not.toBe(first);
    expect(deriveBrokerRequestId(first, 0)).toBe(deriveBrokerRequestId(first, 0));
    expect(deriveBrokerRequestId(first, 0)).not.toBe(deriveBrokerRequestId(first, 1));
  });
});
