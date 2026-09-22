/**
 * @file test/preparations/gates.test.ts
 * @description Host-authored, digest-bound gate proofs (design section 17). Only
 * the eight closed gate kinds and three closed decisions are accepted; the gate
 * kind selects the required grant; every bound digest is recomputed from the
 * authoritative plan rather than asserted by the caller; and an advisory field
 * smuggled onto a principal is not an authorization cache.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import {
  authorGateProof, GATE_DECISIONS, GateAuthorityError, PREPARATION_GATE_KINDS,
  type GateAuthorityState,
} from "../../src/preparations/gates.js";
import type { PreparationPrincipal } from "../../src/preparations/principals.js";
import type { PhaseGateContractV1 } from "../../src/preparations/plan-types.js";
import { validPlan } from "./plan-fixture.js";

const RUN_ID = `prr_${"1".repeat(32)}` as const;
const PHASE = `phi_${"b".repeat(64)}` as const;
const cli: PreparationPrincipal = { id: "operator", surface: "cli", grants: [] };
const DIGEST = parseSha256Digest(`sha256:${"a".repeat(64)}`);

function authState(gate: PhaseGateContractV1, overrides: Partial<GateAuthorityState> = {}): GateAuthorityState {
  const plan = parsePreparationPlan(JSON.stringify(validPlan()));
  return {
    runId: RUN_ID, plan, gate, phaseInstanceId: PHASE,
    currentInput: plan.initialInputSet, ...overrides,
  };
}

const reviewGate: PhaseGateContractV1 = { gateId: "review", gateKind: "review-preparation" };

describe("preparation gate proofs", () => {
  it("closes the gate-kind and decision vocabularies to their exact contract", () => {
    expect([...PREPARATION_GATE_KINDS]).toEqual([
      "confirm-input-exposure", "confirm-cost", "confirm-external-effect", "confirm-residual-risk",
      "review-selection", "review-preparation", "discussion-checkpoint", "confirm-abandonment",
    ]);
    expect([...GATE_DECISIONS]).toEqual(["approved", "rejected", "revised"]);
    expect(() => authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: authState({ gateId: "x", gateKind: "confirm-teleport" } as unknown as PhaseGateContractV1) })).toThrow(GateAuthorityError);
  });

  it("authors an approval binding the recomputed plan digest", () => {
    const state = authState(reviewGate);
    const proof = authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: state });
    expect(proof.summary.decision).toBe("approved");
    expect(proof.summary.planDigest).toBe(canonicalDigest(state.plan));
    expect(proof.fact.bound.planDigest).toBe(canonicalDigest(state.plan));
  });

  it("records a rejection with its reason code and a revision", () => {
    const state = authState(reviewGate);
    const rejected = authorGateProof({ principal: cli, choice: "rejected", decisionIndex: 1, at: DATE(), authoritative: state, reasonCode: "stale-input" });
    expect(rejected.fact.reasonCode).toBe("stale-input");
    expect(authorGateProof({ principal: cli, choice: "revised", decisionIndex: 2, at: DATE(), authoritative: state }).summary.decision).toBe("revised");
  });

  it("rejects an unknown gate kind and an unknown decision", () => {
    const bogus = authState({ gateId: "x", gateKind: "confirm-teleport" } as unknown as PhaseGateContractV1);
    expect(() => authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: bogus })).toThrow(/unknown-gate-kind/);
    expect(() => authorGateProof({ principal: cli, choice: "maybe" as never, decisionIndex: 0, at: DATE(), authoritative: authState(reviewGate) })).toThrow(/unknown-decision/);
  });

  it("requires the gate kind's grant, failing an SDK caller closed", () => {
    const effectGate: PhaseGateContractV1 = { gateId: "effect", gateKind: "confirm-external-effect" };
    const sdk: PreparationPrincipal = { id: "svc", surface: "sdk", grants: ["preparation.gate.decide"] };
    expect(() => authorGateProof({ principal: sdk, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: authState(effectGate, { currentEffectPlanDigest: DIGEST }) })).toThrow(/missing-grant/);
    expect(() => authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: authState(effectGate, { currentEffectPlanDigest: DIGEST }) })).not.toThrow();
  });

  it("derives the bound plan digest from the plan, not a caller claim", () => {
    const object = validPlan();
    object.workspaceId = "different";
    const drifted = authorGateProof({ principal: cli, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: authState(reviewGate, { plan: parsePreparationPlan(JSON.stringify(object)) }) });
    expect(drifted.fact.bound.planDigest).not.toBe(canonicalDigest(parsePreparationPlan(JSON.stringify(validPlan()))));
  });

  it("treats an advisory field on a principal as no authorization at all", () => {
    const hostile = { id: "svc", surface: "sdk", grants: [], availableActions: ["preparation.gate.decide"] } as unknown as PreparationPrincipal;
    expect(() => authorGateProof({ principal: hostile, choice: "approved", decisionIndex: 0, at: DATE(), authoritative: authState(reviewGate) })).toThrow(/invalid-principal/);
  });
});

function DATE(): string { return "2026-07-20T00:00:00.000Z"; }
