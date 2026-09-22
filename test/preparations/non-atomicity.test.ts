/**
 * @file test/preparations/non-atomicity.test.ts
 * @description Atomicity classes and honest non-atomicity (design section 18.1,
 * 18.4). The three classes are cross-checked at runtime exactly as at plan load;
 * a `non-atomic-external-before-local` run requires a residual-risk gate and is
 * labelled non-atomic forever because the label derives from the immutable plan
 * class, never from a later run state; and an ephemeral plan is exempt from the
 * durable atomicity cross-check.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { deriveGateProofId } from "../../src/preparations/ids.js";
import {
  assertAtomicityClassConsistency, assertRuntimeEffectPermitted,
  externalLocalAtomicityLabel,
} from "../../src/preparations/effects.js";
import type { NormalizedPreparationPlanV1, PhaseGateContractV1 } from "../../src/preparations/plan-types.js";
import type { GateProofSummaryV1 } from "../../src/preparations/run-types.js";

const DIGEST = parseSha256Digest(`sha256:${"a".repeat(64)}`);
const RUN_ID = `prr_${"1".repeat(32)}` as const;
const EFFECT_GATE: PhaseGateContractV1 = { gateId: "send", gateKind: "confirm-external-effect" };
const RESIDUAL_GATE: PhaseGateContractV1 = { gateId: "risk", gateKind: "confirm-residual-risk" };

interface PlanOpts { effect?: boolean; handoff?: boolean; gates?: PhaseGateContractV1[]; mode?: string }

function plan(atomicityClass: string, opts: PlanOpts = {}): NormalizedPreparationPlanV1 {
  const phases: unknown[] = [];
  if (opts.effect) phases.push({ effectPlanDigest: DIGEST });
  for (const gate of opts.gates ?? []) phases.push({ gate });
  return {
    executionMode: opts.mode ?? "durable-preparation", atomicityClass, phases,
    outputContract: opts.handoff ? { producingPhaseIds: ["p"], handoffCapacity: {} } : { producingPhaseIds: ["p"] },
  } as unknown as NormalizedPreparationPlanV1;
}

function approved(gateId: string, planDigest: string): GateProofSummaryV1 {
  return {
    gateProofId: deriveGateProofId({ runId: RUN_ID, gateId, planDigest, decisionIndex: 0 }), gateId, decision: "approved",
    decisionIndex: 0, planDigest: parseSha256Digest(planDigest), phaseDigest: DIGEST, inputDigest: DIGEST,
    authorityDigest: DIGEST, actor: { id: "operator", surface: "cli" }, at: "2026-07-20T00:00:00.000Z",
  };
}

describe("atomicity class consistency", () => {
  it("accepts each class that matches its effect, bundle, and gate signals", () => {
    expect(() => assertAtomicityClassConsistency(plan("local-bundle-only", { handoff: true }))).not.toThrow();
    expect(() => assertAtomicityClassConsistency(plan("external-effect-only", { effect: true }))).not.toThrow();
    expect(() => assertAtomicityClassConsistency(plan("non-atomic-external-before-local", { effect: true, handoff: true, gates: [RESIDUAL_GATE] }))).not.toThrow();
  });

  it("rejects a class inconsistent with the plan's signals", () => {
    expect(() => assertAtomicityClassConsistency(plan("local-bundle-only", { effect: true, handoff: true }))).toThrow(/atomicity-inconsistent/);
    expect(() => assertAtomicityClassConsistency(plan("external-effect-only", { effect: true, handoff: true }))).toThrow(/atomicity-inconsistent/);
    expect(() => assertAtomicityClassConsistency(plan("non-atomic-external-before-local", { effect: true, handoff: true }))).toThrow(/atomicity-inconsistent/);
  });

  it("exempts an ephemeral plan from the durable cross-check", () => {
    expect(() => assertAtomicityClassConsistency(plan("external-effect-only", { mode: "ephemeral-read" }))).not.toThrow();
  });
});

describe("honest non-atomicity", () => {
  it("labels a non-atomic-external-before-local plan non-atomic and every other class single-authority", () => {
    expect(externalLocalAtomicityLabel(plan("non-atomic-external-before-local", { effect: true, handoff: true, gates: [RESIDUAL_GATE] }))).toBe("non-atomic");
    expect(externalLocalAtomicityLabel(plan("external-effect-only", { effect: true }))).toBe("single-authority");
    expect(externalLocalAtomicityLabel(plan("local-bundle-only", { handoff: true }))).toBe("single-authority");
  });

  it("keeps the label plan-derived so no run state can reconcile it to atomic", () => {
    const p = plan("non-atomic-external-before-local", { effect: true, handoff: true, gates: [RESIDUAL_GATE] });
    // The label is a pure function of the immutable class; repeated evaluation is stable.
    expect(externalLocalAtomicityLabel(p)).toBe(externalLocalAtomicityLabel(p));
    expect(externalLocalAtomicityLabel(p)).toBe("non-atomic");
  });

  it("requires an approved residual-risk gate before a non-atomic effect", () => {
    const p = plan("non-atomic-external-before-local", { effect: true, handoff: true, gates: [EFFECT_GATE, RESIDUAL_GATE] });
    const planDigest = parseSha256Digest(canonicalDigest(p));
    expect(() => assertRuntimeEffectPermitted({ plan: p, gateProofs: [approved("send", planDigest)], externalEffectGateId: "send", currentPlanDigest: planDigest })).toThrow(/missing-residual-risk-gate/);
    expect(() => assertRuntimeEffectPermitted({ plan: p, gateProofs: [approved("send", planDigest), approved("risk", planDigest)], externalEffectGateId: "send", currentPlanDigest: planDigest })).not.toThrow();
  });
});
