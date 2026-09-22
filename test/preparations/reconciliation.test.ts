/**
 * @file test/preparations/reconciliation.test.ts
 * @description Host-authored reconciliation decisions (design section 21.2). The
 * decision vocabulary and the reason codes are closed to the registered handler
 * contract, the policy digest is recomputed rather than accepted, `needs-operator`
 * BECOMES A GATE bound to the exact pending reconciliation set, and `defer` cannot
 * silently satisfy required output.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  RECONCILIATION_DECISIONS, ReconciliationAuthorityError, assertDeferPermitted,
  assertReconciliationsSettled, decideReconciliation, pendingOperatorReconciliations,
  reconciliationSetDigest, type ReconciliationDecideInputV1,
} from "../../src/preparations/reconciliation.js";
import { normalizeProviderProposals } from "../../src/preparations/proposals.js";
import { capturePolicyContract, type PreparationPolicyContractV1 } from "../../src/preparations/selection.js";
import { GateAuthorityError } from "../../src/preparations/gates.js";
import type { GateProofSummaryV1 } from "../../src/preparations/run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "../../src/preparations/types.js";
import type { AttemptId, GateProofId } from "../../src/preparations/ids.js";

const HANDLER_DIGEST = `sha256:${"3".repeat(64)}` as Sha256Digest;
const PROVIDER_PIN = `sha256:${"4".repeat(64)}` as Sha256Digest;
const PLAN_DIGEST = `sha256:${"6".repeat(64)}` as Sha256Digest;
const PHASE_DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const AUTHORITY_DIGEST = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ATTEMPT = `pat_${"a".repeat(64)}` as AttemptId;

const evidence: EvidenceRefV1 = {
  kind: "reconciliation-finding", mediaType: "application/json", provenanceLabel: "host-derived",
  digest: parseSha256Digest(`sha256:${"b".repeat(64)}`), byteCount: 64, sensitivity: "ordinary", retention: "audit",
  producer: { kind: "host", contractDigest: HANDLER_DIGEST }, untrusted: true,
};

const contract = capturePolicyContract({
  resolve: (): PreparationPolicyContractV1 => ({
    handlerId: "reconcile", handlerContractVersion: "1.2.0", handlerContractDigest: HANDLER_DIGEST,
    exclusionReasonCodes: ["below-rank-limit"],
    reconciliationReasonCodes: ["duplicate-entity", "conflicting-claim"],
    proposalKinds: ["entity-fact"],
  }),
}, { handlerId: "reconcile", handlerContractVersion: "1.2.0", handlerContractDigest: HANDLER_DIGEST });

const proposals = normalizeProviderProposals({
  contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN,
  sourceEvidenceRefs: [{ ...evidence, kind: "provider-output" }],
  drafts: [
    { proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:ada", proposedValue: { born: 1815 } },
    { proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:ada", proposedValue: { born: 1816 } },
  ],
});

/** Build one reconciliation decision input over both normalized proposals. */
function input(overrides: Partial<ReconciliationDecideInputV1> = {}): ReconciliationDecideInputV1 {
  return {
    reconciliationId: "ada-birth-year", contract, proposals,
    proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "accept",
    reasonCodes: ["conflicting-claim"], evidenceRefs: [evidence], ...overrides,
  };
}

/** Assert that deciding the perturbed reconciliation fails closed with the code. */
function expectCode(overrides: Partial<ReconciliationDecideInputV1>, code: string): void {
  try {
    decideReconciliation(input(overrides));
    throw new Error("expected a reconciliation refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ReconciliationAuthorityError);
    expect((error as ReconciliationAuthorityError).code).toBe(code);
  }
}

/** Build an approved gate proof bound to the given pending reconciliation digest. */
function approvedProof(inputDigest: Sha256Digest): GateProofSummaryV1 {
  return {
    gateProofId: `gpf_${"c".repeat(64)}` as GateProofId, gateId: "review", decision: "approved",
    decisionIndex: 0, planDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST, inputDigest,
    authorityDigest: AUTHORITY_DIGEST, actor: { id: "operator", surface: "cli" }, at: "2026-07-23T00:00:00.000Z",
  };
}

describe("host-authored reconciliation decisions", () => {
  it("closes the decision vocabulary to the exact six design decisions", () => {
    expect([...RECONCILIATION_DECISIONS]).toEqual([
      "accept", "reject", "merge", "supersede", "defer", "needs-operator",
    ]);
  });

  it("recomputes the policy digest instead of accepting one", () => {
    const decided = decideReconciliation(input());
    expect(Object.keys(decided).sort()).toEqual([
      "decision", "evidenceRefs", "policyDigest", "proposalIds", "reasonCodes",
      "reconciliationId", "schemaVersion",
    ]);
    expect(decideReconciliation(input({ decision: "merge" })).policyDigest).not.toBe(decided.policyDigest);
    expectCode({ policyDigest: HANDLER_DIGEST } as Partial<ReconciliationDecideInputV1>, "invalid-reconciliation");
  });

  it("rejects a proposal id outside the settled proposal set", () => {
    expectCode({ proposalIds: [`ppl_${"0".repeat(64)}`] }, "unknown-proposal");
    expectCode({ proposalIds: [] }, "invalid-reconciliation");
    expectCode({ proposalIds: [proposals[0]!.proposalId, proposals[0]!.proposalId] }, "duplicate-proposal");
  });

  it("closes the reason codes to the registered contract vocabulary", () => {
    expectCode({ reasonCodes: ["provider-preferred"] }, "unknown-reason-code");
    expectCode({ reasonCodes: [] }, "missing-reason-code");
    expectCode({ decision: "settle" as ReconciliationDecideInputV1["decision"] }, "invalid-decision");
  });

  it("carries an optional host result digest only for a resolving decision", () => {
    const merged = decideReconciliation(input({ decision: "merge", resultDigest: AUTHORITY_DIGEST }));
    expect(merged.resultDigest).toBe(AUTHORITY_DIGEST);
    expectCode({ decision: "needs-operator", resultDigest: AUTHORITY_DIGEST }, "result-not-resolved");
  });
});

describe("needs-operator is a gate, not a silent pass", () => {
  const pending = [decideReconciliation(input({ decision: "needs-operator" }))];

  it("reports the pending operator obligations", () => {
    expect(pendingOperatorReconciliations(pending)).toHaveLength(1);
    expect(pendingOperatorReconciliations([decideReconciliation(input())])).toHaveLength(0);
  });

  it("blocks settlement when no approved gate proof exists", () => {
    try {
      assertReconciliationsSettled({
        records: pending, gateProofs: [], gateId: "review", currentPlanDigest: PLAN_DIGEST,
        phaseDigest: PHASE_DIGEST, authorityDigest: AUTHORITY_DIGEST,
      });
      throw new Error("expected a reconciliation refusal");
    } catch (error) {
      expect((error as ReconciliationAuthorityError).code).toBe("needs-operator-gate-missing");
    }
  });

  it("refuses a proof approved for a different pending reconciliation set", () => {
    expect(() => assertReconciliationsSettled({
      records: pending, gateProofs: [approvedProof(AUTHORITY_DIGEST)], gateId: "review",
      currentPlanDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST, authorityDigest: AUTHORITY_DIGEST,
    })).toThrowError(GateAuthorityError);
  });

  it("accepts only a proof bound to the exact pending reconciliation digest", () => {
    expect(() => assertReconciliationsSettled({
      records: pending, gateProofs: [approvedProof(reconciliationSetDigest(pending))], gateId: "review",
      currentPlanDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST, authorityDigest: AUTHORITY_DIGEST,
    })).not.toThrow();
  });

  it("never treats a rejected or stale-plan proof as settlement", () => {
    const digest = reconciliationSetDigest(pending);
    const settle = (proof: GateProofSummaryV1) => assertReconciliationsSettled({
      records: pending, gateProofs: [proof], gateId: "review", currentPlanDigest: PLAN_DIGEST,
      phaseDigest: PHASE_DIGEST, authorityDigest: AUTHORITY_DIGEST,
    });
    expect(() => settle({ ...approvedProof(digest), decision: "rejected" })).toThrowError(ReconciliationAuthorityError);
    expect(() => settle({ ...approvedProof(digest), planDigest: HANDLER_DIGEST })).toThrowError(ReconciliationAuthorityError);
  });
});

describe("deferred proposals cannot satisfy required output", () => {
  const deferred = [decideReconciliation(input({ decision: "defer" }))];

  it("refuses a deferred proposal that the output contract requires", () => {
    try {
      assertDeferPermitted({ records: deferred, requiredProposalIds: [proposals[0]!.proposalId] });
      throw new Error("expected a reconciliation refusal");
    } catch (error) {
      expect((error as ReconciliationAuthorityError).code).toBe("defer-not-optional");
    }
  });

  it("permits a deferred proposal the output contract declares optional", () => {
    expect(() => assertDeferPermitted({ records: deferred, requiredProposalIds: [] })).not.toThrow();
  });
});
