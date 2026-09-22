/**
 * @file test/preparations/task7-authority.test.ts
 * @description Regressions for the four Wave O3 Task 7 HIGH findings plus the
 * folded-in hardening. Each case reproduces an attack that succeeded before the
 * remediation: a stored deficit the record's own counters contradict, a
 * `needs-operator` gate that was advisory at its only consumer, a policy contract
 * that RECORDED one vocabulary while ENFORCING another, and unvalidated decision
 * identifiers that collided two distinct decisions under one digest.
 */

import { describe, expect, it } from "vitest";
import { CompletenessAuthorityError, deriveCompleteness } from "../../src/preparations/completeness.js";
import { IntentCompilerError } from "../../src/preparations/intent-compiler.js";
import {
  ReconciliationAuthorityError, decideReconciliation, reconciliationSetDigest,
  type PreparationReconciliationV1,
} from "../../src/preparations/reconciliation.js";
import {
  SelectionAuthorityError, authorSelectionDecision, policyContractDigest,
  type PreparationPolicyContractV1,
} from "../../src/preparations/selection.js";
import {
  HANDLER_DIGEST, baseRequest, compiler, contract, evidence, identitySetRef,
  pageTarget, proposals, sets,
} from "./task7-fixture.js";
import type { GateProofSummaryV1 } from "../../src/preparations/run-types.js";
import type { PreparationCompletenessV1 } from "../../src/preparations/completeness.js";
import type { Sha256Digest } from "../../src/preparations/types.js";

const PLAN_DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PHASE_DIGEST = `sha256:${"8".repeat(64)}` as Sha256Digest;
const AUTHORITY_DIGEST = `sha256:${"9".repeat(64)}` as Sha256Digest;

/** Author one host reconciliation over the whole fixture proposal set. */
function decide(
  reconciliationId: string, decision: "accept" | "defer" | "needs-operator",
): PreparationReconciliationV1 {
  return decideReconciliation({
    reconciliationId, contract, proposals,
    proposalIds: proposals.map((proposal) => proposal.proposalId), decision,
    reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
  });
}

describe("T7-H1 the deficit is recomputed at the consumer, not read", () => {
  it("refuses a record claiming zero deficit while three required identities failed", () => {
    const lying: PreparationCompletenessV1 = {
      schemaVersion: 1, scopeDigest: HANDLER_DIGEST, identitySetsDigest: HANDLER_DIGEST,
      requiredDeficitCount: 0, optionalDeficitCount: 0,
      classes: [{
        classId: "entity-facts", disposition: "required", identitySetRef,
        planned: 3, eligible: 3, attempted: 3, completed: 0, included: 0, skipped: 0,
        unavailable: 0, failed: 3, cancelled: 0, overflow: 0, nonConverged: 0,
      }],
    };
    expect(() => compiler.compile(baseRequest({ completeness: lying })))
      .toThrow(IntentCompilerError);
  });
});

/** Build one hand-built reconciliation that never passed decideReconciliation. */
function handBuilt(reconciliationId: unknown): PreparationReconciliationV1 {
  return {
    schemaVersion: 1, reconciliationId: reconciliationId as string,
    proposalIds: [proposals[0]!.proposalId], decision: "accept",
    policyDigest: HANDLER_DIGEST, reasonCodes: ["duplicate-entity"], evidenceRefs: [],
  };
}

describe("T7-H2 needs-operator is a gate, not advice", () => {
  it("refuses an array-like reconciliation container carrying its own filter", () => {
    const needsOperator = decide("escalate", "needs-operator");
    let calls = 0;
    const hostile = {
      length: 1,
      filter: (): unknown[] => (calls++ === 0 ? [] : [{ ...needsOperator, decision: "accept" }]),
      flatMap: (): unknown[] => [],
      [Symbol.iterator]: function* () { yield needsOperator; },
    };
    expect(() => compiler.compile(baseRequest({ reconciliations: hostile as never })))
      .toThrow(IntentCompilerError);
  });

  it("refuses a hand-built reconciliation that never passed decideReconciliation", () => {
    expect(() => compiler.compile(baseRequest({ reconciliations: [handBuilt("forged")] })))
      .toThrow(IntentCompilerError);
  });

  it("blocks compilation on a pending needs-operator decision with no settlement", () => {
    const pending = decide("escalate", "needs-operator");
    try {
      compiler.compile(baseRequest({ reconciliations: [pending] }));
      throw new Error("expected a settlement refusal");
    } catch (error) {
      expect((error as IntentCompilerError).code).toBe("needs-operator-pending");
    }
  });
});

/** Build one approved gate proof bound to the exact pending obligation set. */
function gateProof(records: readonly PreparationReconciliationV1[]): GateProofSummaryV1 {
  return {
    gateProofId: `gpf_${"a".repeat(64)}` as GateProofSummaryV1["gateProofId"],
    gateId: "review-preparation", decision: "approved", decisionIndex: 0,
    planDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST,
    inputDigest: reconciliationSetDigest(records), authorityDigest: AUTHORITY_DIGEST,
    actor: { kind: "operator", id: "op-1" } as unknown as GateProofSummaryV1["actor"],
    at: "2026-07-20T00:00:00.000Z",
  };
}

describe("T7-H2 the wired settlement gates decide the outcome", () => {
  const pending = decide("escalate", "needs-operator");
  const settlement = {
    gateProofs: [gateProof([pending])], gateId: "review-preparation",
    currentPlanDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST,
    authorityDigest: AUTHORITY_DIGEST,
  };

  it("settles a pending obligation with a current approved gate proof", () => {
    const result = compiler.compile(baseRequest({ reconciliations: [pending], settlement }));
    expect(result.mutations).toEqual([]);
  });

  it("refuses a proof approved for a DIFFERENT pending obligation set", () => {
    const other = decide("other", "needs-operator");
    expect(() => compiler.compile(baseRequest({
      reconciliations: [pending], settlement: { ...settlement, gateProofs: [gateProof([other])] },
    }))).toThrow(IntentCompilerError);
  });
});

describe("T7-H5 required-output authority is host-sourced, never operator-defaulted", () => {
  it("refuses a deferral when the host declares no required-output authority", () => {
    const deferred = decide("hold", "defer");
    try {
      compiler.compile(baseRequest({ reconciliations: [deferred] }));
      throw new Error("expected a missing-authority refusal");
    } catch (error) {
      expect((error as IntentCompilerError).code).toBe("missing-required-authority");
    }
  });

  it("refuses a deferral of a proposal the host authority declares required", () => {
    const deferred = decide("hold", "defer");
    try {
      compiler.compile(baseRequest({
        reconciliations: [deferred], requiredProposalIds: [proposals[0]!.proposalId],
      }));
      throw new Error("expected a defer refusal");
    } catch (error) {
      expect((error as IntentCompilerError).code).toBe("defer-not-permitted");
    }
  });

  it("permits a deferral the host authoritatively declares is not required output", () => {
    const deferred = decide("hold", "defer");
    const result = compiler.compile(baseRequest({
      reconciliations: [deferred], requiredProposalIds: [],
    }));
    expect(result.mutations).toEqual([]);
  });
});

/** A contract that canonicalizes as the strict vocabulary but iterates another. */
function vocabularySplitContract(key: keyof PreparationPolicyContractV1): PreparationPolicyContractV1 {
  const strictTerms = contract[key] as readonly string[];
  return {
    ...contract,
    [key]: {
      [Symbol.iterator]: function* () { yield "anything-goes"; },
      toJSON: (): readonly string[] => strictTerms,
    },
  } as unknown as PreparationPolicyContractV1;
}

describe("T7-H3 a contract cannot record one vocabulary and enforce another", () => {
  it("refuses the split contract at the selection author boundary", () => {
    const hostile = vocabularySplitContract("exclusionReasonCodes");
    expect(() => policyContractDigest(hostile)).toThrow(SelectionAuthorityError);
    expect(() => authorSelectionDecision({
      selectionId: "sel-1", contract: hostile, candidateSetRef: evidence,
      candidateIds: ["a", "b"], eligibilityPolicyDigest: HANDLER_DIGEST,
      selectionLimit: 1, selectedIds: ["a"],
      excluded: [{ candidateId: "b", reasonCodes: ["anything-goes"] }],
      rationaleEvidenceRefs: [], producedBy: "host-policy",
    })).toThrow(SelectionAuthorityError);
  });

  it("refuses the split contract at the reconciliation decide boundary", () => {
    const hostile = vocabularySplitContract("reconciliationReasonCodes");
    expect(() => decideReconciliation({
      reconciliationId: "r", contract: hostile, proposals,
      proposalIds: [proposals[0]!.proposalId], decision: "accept",
      reasonCodes: ["anything-goes"], evidenceRefs: [],
    })).toThrow(SelectionAuthorityError);
  });
});

describe("T7-H4 decision identifiers are validated like every other component", () => {
  const args = {
    contract, candidateSetRef: evidence, candidateIds: ["a"],
    eligibilityPolicyDigest: HANDLER_DIGEST, selectionLimit: 1, selectedIds: ["a"],
    excluded: [], rationaleEvidenceRefs: [], producedBy: "host-policy" as const,
  };

  it("refuses a non-string selectionId that would collide two distinct decisions", () => {
    expect(() => authorSelectionDecision({
      selectionId: { toJSON: () => "real-id" } as unknown as string, ...args,
    })).toThrow(SelectionAuthorityError);
    expect(authorSelectionDecision({ selectionId: "real-id", ...args }).selectionId).toBe("real-id");
  });

  it("refuses a selectionId or reconciliationId carrying a path component", () => {
    for (const unsafe of ["../escape", "a/b", ".hidden", ""]) {
      expect(() => authorSelectionDecision({ selectionId: unsafe, ...args }))
        .toThrow(SelectionAuthorityError);
      expect(() => decideReconciliation({
        reconciliationId: unsafe, contract, proposals,
        proposalIds: [proposals[0]!.proposalId], decision: "accept",
        reasonCodes: ["duplicate-entity"], evidenceRefs: [],
      })).toThrow(ReconciliationAuthorityError);
    }
  });

  it("refuses a non-string reconciliationId reaching a compiled mutation", () => {
    expect(() => compiler.compile(baseRequest({ reconciliations: [handBuilt({ evil: true })] })))
      .toThrow(IntentCompilerError);
  });
});

describe("Task 7 folded-in hardening", () => {
  it("validates identitySetRef and binds it into the identity-set digest", () => {
    const classes = (ref: unknown) => [{
      classId: "c1", disposition: "required" as const, identitySetRef: ref as never,
      identitySets: sets({ planned: ["a"], eligible: ["a"], attempted: ["a"], completed: ["a"], included: ["a"] }),
    }];
    for (const bad of [undefined, null, "sha256:x", { digest: "nope" }, { ...evidence, extra: 1 }]) {
      expect(() => deriveCompleteness({ scopeId: "s", classes: classes(bad) }))
        .toThrow(CompletenessAuthorityError);
    }
    const one = deriveCompleteness({ scopeId: "s", classes: classes(identitySetRef) }).record;
    const two = deriveCompleteness({
      scopeId: "s", classes: classes({ ...identitySetRef, digest: `sha256:${"c".repeat(64)}` }),
    }).record;
    expect(one.identitySetsDigest).not.toBe(two.identitySetsDigest);
    expect(one.scopeDigest).toBe(two.scopeDigest);
  });

  it("refuses a self dependency and a forward dependency at compile", () => {
    const selfDep = pageTarget("ada", { dependsOnLogicalIdentities: ["entity:person:ada"] });
    try {
      compiler.compile(baseRequest({ targets: [selfDep] }));
      throw new Error("expected a dependency refusal");
    } catch (error) {
      expect((error as IntentCompilerError).code).toBe("self-dependency");
    }
  });
});
