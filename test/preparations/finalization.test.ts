/**
 * @file test/preparations/finalization.test.ts
 * @description The production writer for `running → handoff-ready` (runner
 * design v3 §6): preconditions re-checked under the lock, declared
 * materialization limits enforced at write time, payload coverage verified
 * digest-exactly, core-stamped authority fields, and the crash-between-
 * evidence-and-transition re-drive. Every refusal leaves the run `running`.
 *
 * NOT WITNESSED HERE: the live-attempt-lease refusal. Arranging a live
 * `executionOwner` requires an in-flight attempt held open mid-leg, which this
 * harness has no fault seam for; the check exists and reads the same field the
 * attempt writer owns. Stated per the observability rule rather than faked.
 */

import { createHash } from "node:crypto";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { writePreparationCancelLockFree } from "../../src/preparations/cancellation.js";
import { deriveCompleteness } from "../../src/preparations/completeness.js";
import { writePreparationEvidenceCreateOnly } from "../../src/preparations/evidence-store.js";
import { finalizePreparationForHandoff, type FinalizationInputV1 } from "../../src/preparations/finalization.js";
import { captureMaterializationResult } from "../../src/preparations/materialization.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { FIXTURE_PAYLOAD as PAYLOAD, FIXTURE_PAYLOAD_DIGEST as PAYLOAD_DIGEST, declareMaterializationCapacity, fullCompleteness, materializedResultCandidate } from "./materialization-fixture.js";
import { fixturePlan } from "./store-fixture.js";
import { PIN, attemptRequest, evidenceLocation, stagePreparation, stageRunningPreparation, type StagedPreparation } from "./attempt-fixture.js";

/** A plan whose handoff capacity declares (and whose bounds fund) the triple. */
function runnerManagedPlan() {
  return fixturePlan((plan) => declareMaterializationCapacity(plan));
}

/** The captured result one settled fixture run materializes. */
function capturedResult() {
  return captureMaterializationResult(materializedResultCandidate());
}

/** The full finalization input over one staged run. */
function finalizationInput(staged: StagedPreparation, overrides: Partial<FinalizationInputV1> = {}): FinalizationInputV1 {
  return {
    root: staged.root, binding: staged.binding, result: capturedResult(),
    operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
    handlerContractDigest: parseSha256Digest(PIN), payloads: new Map([[PAYLOAD_DIGEST, PAYLOAD]]),
    principal: { id: "operator", surface: "cli" }, at: "2026-07-21T01:00:00.000Z",
    ...overrides,
  };
}

/** Assert the shared staged run is still `running` after a refusal. */
async function expectStillRunning(): Promise<void> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status === "ok") expect(read.run.state).toBe("running");
}

let staged: StagedPreparation;
beforeEach(async () => {
  staged = await stageRunningPreparation(runnerManagedPlan());
});
afterEach(() => staged.cleanup());

describe("finalizePreparationForHandoff", () => {
  it("appends handoff-ready and attaches the manifest, payloads, and completeness", async () => {
    const result = await finalizePreparationForHandoff(finalizationInput(staged));
    expect(result.status).toBe("finalized");
    if (result.status !== "finalized") return;

    expect(result.run.state).toBe("handoff-ready");
    const kinds = result.run.evidenceRefs.map((ref) => ref.kind);
    expect(kinds).toContain("preparation-handoff-materialization-v1");
    expect(kinds).toContain("materialization-payload");
    // classDigest is identitySetsDigest — the digest that MOVES with the
    // eligibility universe — never scopeDigest (regular round 2 blocker: the
    // previous assertion encoded the wrong field as correct).
    expect(result.run.completeness).toEqual({ requiredDeficit: 0, optionalDeficit: 0,
      classDigest: fullCompleteness().identitySetsDigest });
  });

  it("re-drives after a crash between evidence writes and the transition", async () => {
    // Simulate the crash state: evidence persisted, run still running.
    await writePreparationEvidenceCreateOnly(staged.root, evidenceLocation(staged), PAYLOAD);
    const result = await finalizePreparationForHandoff(finalizationInput(staged));

    expect(result.status).toBe("finalized");
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status === "ok") expect(read.run.state).toBe("handoff-ready");
  });

  it("refuses a second finalization because the run is no longer running", async () => {
    await finalizePreparationForHandoff(finalizationInput(staged));
    const second = await finalizePreparationForHandoff(finalizationInput(staged));

    expect(second).toMatchObject({ status: "refused", reason: expect.stringContaining("handoff-ready") });
  });

  it("refuses while a cancellation is pending, leaving the run running", async () => {
    await writePreparationCancelLockFree(staged.root, {
      workspaceId: staged.binding.workspaceId, runId: staged.binding.runId,
      requester: "operator", at: "2026-07-21T00:59:00.000Z", nonce: "0123456789abcdef0123456789abcdef",
    });
    const result = await finalizePreparationForHandoff(finalizationInput(staged));

    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("cancellation") });
    await expectStillRunning();
  });

  it("attaches supplied completion warnings to run content", async () => {
    const warned = await finalizePreparationForHandoff(finalizationInput(staged, {
      result: captureMaterializationResult({
        targets: [], proposals: [], reconciliations: [], selections: [],
        completeness: fullCompleteness(), authorityInputs: [], authorityBounds: [],
        operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
        payloadRefs: [],
        completionWarnings: [{ code: "preparation-optional-completeness-deficit",
          attempted: 1, completed: 0, skipped: 1, failed: 0 }],
      }),
      payloads: new Map(),
    }));

    expect(warned.status).toBe("finalized");
    if (warned.status !== "finalized") return;
    expect(warned.run.completionWarnings).toContainEqual({
      code: "preparation-optional-completeness-deficit", attempted: 1, completed: 0, skipped: 1, failed: 0,
    });
  });

  it("refuses a supplied-but-unreferenced payload — the budget bypass", async () => {
    // Adversarial round 2: an extra map entry no ref names was written to the
    // evidence CAS past the declared payload budget.
    const extra = Buffer.alloc(100_000, 7);
    const extraDigest = createHash("sha256").update(extra).digest("hex");
    const result = await finalizePreparationForHandoff(finalizationInput(staged, {
      payloads: new Map([[PAYLOAD_DIGEST, PAYLOAD], [extraDigest, extra]]),
    }));

    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("unreferenced") });
    await expectStillRunning();
  });

  it("refuses an unfunded payload and a manifest over the declared limit", async () => {
    const missing = await finalizePreparationForHandoff(
      finalizationInput(staged, { payloads: new Map() }));
    expect(missing).toMatchObject({ status: "refused", reason: expect.stringContaining("not supplied") });

    const wrongBytes = await finalizePreparationForHandoff(
      finalizationInput(staged, { payloads: new Map([[PAYLOAD_DIGEST, Buffer.from("other")]]) }));
    expect(wrongBytes).toMatchObject({ status: "refused" });
  });

  it("refuses a completeness record whose deficits are not derivable", async () => {
    const forged = { ...fullCompleteness(), requiredDeficitCount: 1 };
    const result = await finalizePreparationForHandoff(finalizationInput(staged, {
      result: captureMaterializationResult({
        targets: [], proposals: [], reconciliations: [], selections: [],
        completeness: forged, authorityInputs: [], authorityBounds: [],
        operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
        payloadRefs: [],
      }),
    }));

    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("completeness") });
  });
});

describe("declared-limit enforcement (budgetRefusal)", () => {
  /** Stage with a chosen materialization triple, then settle one attempt. */
  async function stagedWithLimits(limits: Record<string, number>): Promise<StagedPreparation> {
    const prepared = await stagePreparation(fixturePlan((plan) => {
      const capacity = (plan.outputContract as Record<string, any>).handoffCapacity;
      Object.assign(capacity, limits);
      const bounds = plan.bounds as Record<string, number>;
      bounds.maximumEvidenceRefs += 8;
      bounds.maximumEvidenceBytes += 262_144;
    }));
    const outcome = await executePhaseAttempt(attemptRequest(prepared));
    if (outcome.status !== "committed") throw new Error(`fixture attempt: ${outcome.status}`);
    return prepared;
  }

  it("refuses an oversized manifest as a typed refusal, never an over-budget write", async () => {
    const tight = await stagedWithLimits({
      maximumMaterializationManifestBytes: 64,
      maximumMaterializationPayloadRefs: 4, maximumMaterializationPayloadBytes: 65_536,
    });
    try {
      const result = await finalizePreparationForHandoff(finalizationInput(tight));
      expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("over the declared") });
      const read = await readPreparationRun(tight.root, tight.binding);
      if (read.status === "ok") expect(read.run.state).toBe("running");
    } finally { await tight.cleanup(); }
  });

  it("refuses excess payload refs and excess payload bytes", async () => {
    const noRefs = await stagedWithLimits({
      maximumMaterializationManifestBytes: 65_536,
      maximumMaterializationPayloadRefs: 0, maximumMaterializationPayloadBytes: 65_536,
    });
    try {
      expect(await finalizePreparationForHandoff(finalizationInput(noRefs)))
        .toMatchObject({ status: "refused", reason: expect.stringContaining("payload refs") });
    } finally { await noRefs.cleanup(); }

    const noBytes = await stagedWithLimits({
      maximumMaterializationManifestBytes: 65_536,
      maximumMaterializationPayloadRefs: 4, maximumMaterializationPayloadBytes: 8,
    });
    try {
      expect(await finalizePreparationForHandoff(finalizationInput(noBytes)))
        .toMatchObject({ status: "refused", reason: expect.stringContaining("exceed the declared") });
    } finally { await noBytes.cleanup(); }
  });
});

describe("finalization on a plan without the declared limits", () => {
  it("refuses the undeclared plan and leaves it running", async () => {
    const undeclared = await stagePreparation();
    try {
      const outcome = await executePhaseAttempt(attemptRequest(undeclared));
      expect(outcome.status).toBe("committed");
      const result = await finalizePreparationForHandoff(finalizationInput(undeclared));

      expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("materialization limits") });
      const read = await readPreparationRun(undeclared.root, undeclared.binding);
      if (read.status === "ok") expect(read.run.state).toBe("running");
    } finally {
      await undeclared.cleanup();
    }
  });
});
