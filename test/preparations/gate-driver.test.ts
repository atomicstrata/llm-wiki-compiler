/**
 * @file test/preparations/gate-driver.test.ts
 * @description The gate lifecycle drivers (Chunk 3 unit C): BLOCK moves a
 * running run to `awaiting-gate` at a gate phase (refusing any other state),
 * and RESUME moves `awaiting-gate` back to `running` on a recorded proceed
 * decision (refusing a run not awaiting the gate, or a gate with no decision).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { blockAtGate, resumeFromGate, type GatePhaseV1 } from "../../src/preparations/gate-driver.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import {
  phaseInstanceIdFor, stagePreparation, stageRunningPreparation, type StagedPreparation,
} from "./attempt-fixture.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";

const ACTOR = { id: "operator", surface: "cli" as const };
const AT = "2026-07-21T02:00:00.000Z";

/** The research pack's `review` gate, materialized at its own logical phase instance. */
function reviewGate(binding: PreparationRunBinding): GatePhaseV1 {
  return {
    logicalPhaseId: "review", gateId: "review", disposition: "required",
    phaseInstanceId: phaseInstanceIdFor(binding, "review"),
    currentPlanDigest: parseSha256Digest(`sha256:${"a".repeat(64)}`),
  };
}

let staged: StagedPreparation;
beforeEach(async () => {
  staged = await stageRunningPreparation();
});
afterEach(() => staged.cleanup());

/** Assert the run is durably still parked at the gate (the untouched-on-refusal invariant). */
async function expectStillAwaitingGate(): Promise<void> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status === "ok") expect(read.run.state).toBe("awaiting-gate");
}

describe("blockAtGate", () => {
  it("moves a running run to awaiting-gate", async () => {
    const result = await blockAtGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);

    expect(result.status).toBe("moved");
    if (result.status !== "moved") return;
    expect(result.run.state).toBe("awaiting-gate");
    await expectStillAwaitingGate();
  });

  it("blocks a LEADING gate from a still-planned run (nothing ran before it), so the gate is decidable", async () => {
    // Without this a leading gate reports "suspended" while the run stays
    // `planned` — no durable gate exists, and the decision command refuses.
    await staged.cleanup();
    staged = await stagePreparation();
    const before = await readPreparationRun(staged.root, staged.binding);
    if (before.status === "ok") expect(before.run.state).toBe("planned");
    const result = await blockAtGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);
    expect(result.status).toBe("moved");
    await expectStillAwaitingGate();
  });

  it("refuses a run that is not running, leaving it untouched", async () => {
    // Block once (→ awaiting-gate), then a second block must refuse, not overwrite.
    await blockAtGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);
    const second = await blockAtGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);

    expect(second).toMatchObject({ status: "refused", reason: expect.stringContaining("awaiting-gate") });
    await expectStillAwaitingGate();
  });
});

describe("resumeFromGate", () => {
  it("refuses a run that is not awaiting-gate", async () => {
    // The fixture run is running (not awaiting-gate) after the beforeEach attempt.
    const result = await resumeFromGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("not awaiting-gate") });
  });

  it("refuses to resume an awaiting-gate run with no recorded proceed decision", async () => {
    // Block first (→ awaiting-gate), but record no decision: resume must refuse,
    // never move the run past a gate that was not authorized.
    await blockAtGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);
    const result = await resumeFromGate(staged.root, staged.binding, reviewGate(staged.binding), ACTOR, AT);

    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("no operative approval") });
    await expectStillAwaitingGate();
  });
});
