/**
 * @file test/preparations/gate-authority-drift.test.ts
 * @description Authority and plan drift before a gate (design section 17.4). A
 * recorded proof is `current` only while every bound digest still matches; a
 * changed input or revised plan is `drifted`; an unreadable current state is
 * `unavailable`; a discussion checkpoint has no live precondition and is
 * `not-applicable`. Reliance requires a fresh approval and refuses everything
 * else fail-closed.
 */

import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  authorGateProof, evaluateGateFreshness, requireFreshApproval, revalidateApprovedGateProof,
  type GateAuthorityState,
} from "../../src/preparations/gates.js";
import type { PreparationPrincipal } from "../../src/preparations/principals.js";
import type { PhaseGateContractV1 } from "../../src/preparations/plan-types.js";
import { validPlan } from "./plan-fixture.js";

const RUN_ID = `prr_${"1".repeat(32)}` as const;
const PHASE = `phi_${"c".repeat(64)}` as const;
const cli: PreparationPrincipal = { id: "operator", surface: "cli", grants: [] };
const AT = "2026-07-20T00:00:00.000Z";

function state(gate: PhaseGateContractV1, planObject: Record<string, unknown> = validPlan()): GateAuthorityState {
  const plan = parsePreparationPlan(JSON.stringify(planObject));
  return { runId: RUN_ID, plan, gate, phaseInstanceId: PHASE, currentInput: plan.initialInputSet };
}

const gate: PhaseGateContractV1 = { gateId: "review", gateKind: "review-preparation" };

function approve(current: GateAuthorityState) {
  return authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: AT, authoritative: current });
}

describe("gate authority drift", () => {
  it("reports current when every bound digest still matches", () => {
    const current = state(gate);
    expect(evaluateGateFreshness(approve(current).fact, current)).toBe("current");
    expect(() => requireFreshApproval(approve(current).fact, current)).not.toThrow();
  });

  it("reports drifted after a plan revision and refuses reliance", () => {
    const original = state(gate);
    const proof = approve(original);
    const revised = validPlan();
    revised.recipeDigest = `sha256:${"d".repeat(64)}`;
    const after = state(gate, revised);
    expect(evaluateGateFreshness(proof.fact, after)).toBe("drifted");
    expect(() => requireFreshApproval(proof.fact, after)).toThrow(/not-fresh/);
  });

  it("reports drifted when the current input digest changes", () => {
    const original = state(gate);
    const proof = approve(original);
    const swapped: GateAuthorityState = { ...original, currentInput: { ...original.currentInput, digest: parseSha256Digest(`sha256:${"e".repeat(64)}`) } };
    expect(evaluateGateFreshness(proof.fact, swapped)).toBe("drifted");
  });

  it("reports unavailable when the current state cannot be read", () => {
    const proof = approve(state(gate));
    expect(evaluateGateFreshness(proof.fact, { unavailable: true })).toBe("unavailable");
    expect(() => requireFreshApproval(proof.fact, { unavailable: true })).toThrow(/not-fresh/);
  });

  it("treats a discussion checkpoint as not-applicable and relies on it", () => {
    const current = state({ gateId: "chat", gateKind: "discussion-checkpoint" });
    const proof = approve(current);
    expect(evaluateGateFreshness(proof.fact, current)).toBe("not-applicable");
    expect(() => requireFreshApproval(proof.fact, current)).not.toThrow();
  });

  it("refuses to rely on a non-approved proof", () => {
    const current = state(gate);
    const rejected = authorGateProof({ principal: cli, choice: "rejected", decisionIndex: 1, at: AT, authoritative: current });
    expect(() => requireFreshApproval(rejected.fact, current)).toThrow(/not-approved/);
  });

  it("revalidates a persisted summary against every current bound dimension", () => {
    const effectGate: PhaseGateContractV1 = { gateId: "send", gateKind: "confirm-external-effect" };
    const current = state(effectGate);
    const proof = authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: AT, authoritative: { ...current, currentEffectPlanDigest: DIGEST } }).summary;
    const binding = { planDigest: proof.planDigest, phaseDigest: proof.phaseDigest, inputDigest: proof.inputDigest, effectDigest: proof.effectDigest, authorityDigest: proof.authorityDigest };
    expect(() => revalidateApprovedGateProof(proof, binding)).not.toThrow();
    expect(() => revalidateApprovedGateProof(proof, { ...binding, phaseDigest: parseSha256Digest(`sha256:${"6".repeat(64)}`) })).toThrow(/not-fresh/);
    expect(() => revalidateApprovedGateProof(proof, { ...binding, inputDigest: parseSha256Digest(`sha256:${"9".repeat(64)}`) })).toThrow(/not-fresh/);
    expect(() => revalidateApprovedGateProof(proof, { ...binding, effectDigest: parseSha256Digest(`sha256:${"8".repeat(64)}`) })).toThrow(/not-fresh/);
    expect(() => revalidateApprovedGateProof(proof, { ...binding, authorityDigest: parseSha256Digest(`sha256:${"7".repeat(64)}`) })).toThrow(/not-fresh/);
  });
});

const DIGEST = parseSha256Digest(`sha256:${"a".repeat(64)}`);
