/**
 * @file test/preparations/plan-materialization-reservation.test.ts
 * @description Stage-time reservation of the runner's finalization overhead
 * (runner design v3 §6): applied exactly when all three materialization limits
 * are declared, absent otherwise — so existing plans keep their envelope
 * byte-identically, a partial declaration funds nothing, and a plan that
 * cannot afford its own finalization is refused at stage rather than
 * completing all work and stranding.
 */

import { describe, expect, it } from "vitest";
import { computePreparationWorstCase } from "../../src/preparations/plan-bounds.js";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { PreparationBoundsError } from "../../src/preparations/problems.js";
import { planText, validPlan } from "./plan-fixture.js";

type Plan = Record<string, any>;

const LIMITS = Object.freeze({
  maximumMaterializationManifestBytes: 4_096,
  maximumMaterializationPayloadRefs: 3,
  maximumMaterializationPayloadBytes: 10_000,
});

/** The valid plan with the triple declared AND the declared bounds funding it. */
function declaredPlan(): Plan {
  const plan = validPlan() as Plan;
  Object.assign(plan.outputContract.handoffCapacity, LIMITS);
  plan.bounds.maximumEvidenceRefs += 1 + LIMITS.maximumMaterializationPayloadRefs;
  plan.bounds.maximumEvidenceBytes +=
    LIMITS.maximumMaterializationManifestBytes + LIMITS.maximumMaterializationPayloadBytes;
  return plan;
}

describe("materialization reservation in the worst-case envelope", () => {
  it("adds exactly one manifest ref plus the declared payload refs and bytes", () => {
    const base = computePreparationWorstCase(parsePreparationPlan(planText(validPlan())));
    const reserved = computePreparationWorstCase(parsePreparationPlan(planText(declaredPlan())));

    expect(reserved.evidenceRefs).toBe(base.evidenceRefs + 1 + LIMITS.maximumMaterializationPayloadRefs);
    expect(reserved.evidenceBytes).toBe(base.evidenceBytes
      + LIMITS.maximumMaterializationManifestBytes + LIMITS.maximumMaterializationPayloadBytes);
  });

  it("keeps the envelope byte-identical for a plan declaring no limits", () => {
    const withTriple = declaredPlan();
    delete withTriple.outputContract.handoffCapacity.maximumMaterializationManifestBytes;
    delete withTriple.outputContract.handoffCapacity.maximumMaterializationPayloadRefs;
    delete withTriple.outputContract.handoffCapacity.maximumMaterializationPayloadBytes;

    expect(computePreparationWorstCase(parsePreparationPlan(planText(withTriple))))
      .toEqual(computePreparationWorstCase(parsePreparationPlan(planText(validPlan()))));
  });

  it("contributes no reservation for a partial declaration", () => {
    const partial = declaredPlan();
    delete partial.outputContract.handoffCapacity.maximumMaterializationPayloadBytes;

    expect(computePreparationWorstCase(parsePreparationPlan(planText(partial))))
      .toEqual(computePreparationWorstCase(parsePreparationPlan(planText(validPlan()))));
  });

  it("refuses at stage a plan that cannot afford its own finalization", () => {
    const base = computePreparationWorstCase(parsePreparationPlan(planText(validPlan())));
    const unfundable = declaredPlan();
    // Declared bound admits the attempt/phase work exactly, and nothing more.
    unfundable.bounds.maximumEvidenceRefs = base.evidenceRefs;

    try {
      parsePreparationPlan(planText(unfundable));
    } catch (error) {
      expect(error).toBeInstanceOf(PreparationBoundsError);
      expect((error as PreparationBoundsError).dimension).toBe("evidence-refs");
      return;
    }
    throw new Error("expected the unfundable plan to be refused at stage");
  });

  it("rejects a non-count materialization limit", () => {
    const bad = declaredPlan();
    bad.outputContract.handoffCapacity.maximumMaterializationPayloadRefs = -1;

    expect(() => parsePreparationPlan(planText(bad))).toThrow();
  });
});
