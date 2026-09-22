/**
 * @file test/preparations/selection.test.ts
 * @description Host-authored source selection (design section 20). The decision
 * binds the EXACT candidate, eligibility, ranking, and limit digests; every
 * candidate is accounted for as selected or excluded; exclusion reason codes come
 * from the registered handler contract's CLOSED vocabulary; and untrusted
 * rationale never enters the authority binding.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  SELECTION_BINDING_DIMENSIONS, SELECTION_BINDING_EXCLUSIONS, SelectionAuthorityError,
  authorSelectionDecision, capturePolicyContract, policyContractDigest,
  type PreparationPolicyContractV1, type SelectionAuthorInputV1,
} from "../../src/preparations/selection.js";
import type { EvidenceRefV1, Sha256Digest } from "../../src/preparations/types.js";
import type { HostHandlerRefV1 } from "../../src/preparations/attempts/types.js";

const HANDLER_DIGEST = `sha256:${"c".repeat(64)}` as Sha256Digest;
const ELIGIBILITY = `sha256:${"d".repeat(64)}` as Sha256Digest;
const RANKING = `sha256:${"e".repeat(64)}` as Sha256Digest;

const handlerRef: HostHandlerRefV1 = {
  handlerId: "screen-sources", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST,
};

const candidateSetRef: EvidenceRefV1 = {
  kind: "candidate-set", mediaType: "application/json", provenanceLabel: "host-derived",
  digest: parseSha256Digest(`sha256:${"1".repeat(64)}`), byteCount: 96, sensitivity: "ordinary", retention: "audit",
  producer: { kind: "host", contractDigest: HANDLER_DIGEST }, untrusted: true,
};

const rationaleRef: EvidenceRefV1 = {
  ...candidateSetRef, kind: "selection-rationale", provenanceLabel: "provider-output",
  digest: parseSha256Digest(`sha256:${"2".repeat(64)}`),
};

/** A registry whose resolved contract can be perturbed per test. */
function registry(contract: Partial<PreparationPolicyContractV1> = {}) {
  return {
    resolve: (): PreparationPolicyContractV1 => ({
      handlerId: handlerRef.handlerId, handlerContractVersion: handlerRef.handlerContractVersion,
      handlerContractDigest: handlerRef.handlerContractDigest,
      exclusionReasonCodes: ["below-rank-limit", "ineligible-license"],
      reconciliationReasonCodes: ["duplicate-entity"], proposalKinds: ["entity-fact"], ...contract,
    }),
  };
}

const contract = capturePolicyContract(registry(), handlerRef);

/** Build one selection author input over three candidates with a limit of two. */
function input(overrides: Partial<SelectionAuthorInputV1> = {}): SelectionAuthorInputV1 {
  return {
    selectionId: "select-sources", contract, candidateSetRef, candidateIds: ["s1", "s2", "s3"],
    eligibilityPolicyDigest: ELIGIBILITY, rankingPolicyDigest: RANKING, selectionLimit: 2,
    selectedIds: ["s1", "s2"], excluded: [{ candidateId: "s3", reasonCodes: ["below-rank-limit"] }],
    rationaleEvidenceRefs: [rationaleRef], producedBy: "host-policy", ...overrides,
  };
}

/** Assert that authoring the perturbed selection fails closed with the exact code. */
function expectCode(overrides: Partial<SelectionAuthorInputV1>, code: string): void {
  try {
    authorSelectionDecision(input(overrides));
    throw new Error("expected a selection refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SelectionAuthorityError);
    expect((error as SelectionAuthorityError).code).toBe(code);
  }
}

describe("host-authored selection decisions", () => {
  it("classifies every decision field as bound or deliberately excluded", () => {
    const decision = authorSelectionDecision(input());
    const classified = [...SELECTION_BINDING_DIMENSIONS, ...SELECTION_BINDING_EXCLUSIONS];
    expect(Object.keys(decision).sort()).toEqual([...classified].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("recomputes the candidate-set digest from the exact candidate identities", () => {
    const decision = authorSelectionDecision(input());
    const reordered = authorSelectionDecision(input({ candidateIds: ["s3", "s1", "s2"] }));
    expect(reordered.candidateSetDigest).toBe(decision.candidateSetDigest);
    const changed = authorSelectionDecision(input({
      candidateIds: ["s1", "s2", "s3", "s4"],
      excluded: [
        { candidateId: "s3", reasonCodes: ["below-rank-limit"] },
        { candidateId: "s4", reasonCodes: ["ineligible-license"] },
      ],
    }));
    expect(changed.candidateSetDigest).not.toBe(decision.candidateSetDigest);
  });

  it("rejects a caller-supplied candidate-set or selection digest", () => {
    expectCode({ candidateSetDigest: ELIGIBILITY } as Partial<SelectionAuthorInputV1>, "invalid-selection");
    expectCode({ selectionDigest: ELIGIBILITY } as Partial<SelectionAuthorInputV1>, "invalid-selection");
  });

  it("requires complete selected and excluded coverage of the candidate set", () => {
    expectCode({ excluded: [] }, "incomplete-coverage");
  });

  it("rejects a selected identity outside the exact candidate set", () => {
    expectCode({ selectedIds: ["s1", "s9"] }, "unknown-candidate");
  });

  it("rejects a duplicated or doubly classified candidate", () => {
    expectCode({ selectedIds: ["s1", "s1"] }, "duplicate-candidate");
    expectCode({
      selectedIds: ["s1", "s2"],
      excluded: [
        { candidateId: "s2", reasonCodes: ["below-rank-limit"] },
        { candidateId: "s3", reasonCodes: ["below-rank-limit"] },
      ],
    }, "duplicate-candidate");
  });

  it("enforces the declared selection limit", () => {
    expectCode({ selectionLimit: 1 }, "limit-exceeded");
  });
});

describe("selection reason codes are a closed contract vocabulary", () => {
  it("rejects an exclusion reason outside the registered contract", () => {
    expectCode({ excluded: [{ candidateId: "s3", reasonCodes: ["provider-said-so"] }] }, "unknown-reason-code");
  });

  it("requires at least one reason code on every exclusion", () => {
    expectCode({ excluded: [{ candidateId: "s3", reasonCodes: [] }] }, "missing-reason-code");
  });

  it("closes the producer vocabulary to host policy and operator gate", () => {
    expectCode({ producedBy: "provider" as SelectionAuthorInputV1["producedBy"] }, "invalid-producer");
    expect(authorSelectionDecision(input({ producedBy: "operator-gate" })).producedBy).toBe("operator-gate");
  });

  it("refuses a contract that does not bind the resolved handler ref", () => {
    expect(() => capturePolicyContract(registry({ handlerId: "other" }), handlerRef))
      .toThrowError(SelectionAuthorityError);
  });

  it("refuses a contract that declares a Milestone A mutation kind as a proposal kind", () => {
    expect(() => capturePolicyContract(registry({ proposalKinds: ["page"] }), handlerRef))
      .toThrowError(SelectionAuthorityError);
  });
});

describe("selection drift and untrusted rationale", () => {
  it("changes the selection digest when any bound policy dimension changes", () => {
    const base = authorSelectionDecision(input()).selectionDigest;
    expect(authorSelectionDecision(input({ eligibilityPolicyDigest: RANKING })).selectionDigest).not.toBe(base);
    expect(authorSelectionDecision(input({ rankingPolicyDigest: ELIGIBILITY })).selectionDigest).not.toBe(base);
    expect(authorSelectionDecision(input({ selectionLimit: 3 })).selectionDigest).not.toBe(base);
    expect(authorSelectionDecision(input({ producedBy: "operator-gate" })).selectionDigest).not.toBe(base);
  });

  it("keeps untrusted rationale evidence out of the authority binding", () => {
    const base = authorSelectionDecision(input()).selectionDigest;
    expect(authorSelectionDecision(input({ rationaleEvidenceRefs: [] })).selectionDigest).toBe(base);
    expect(SELECTION_BINDING_EXCLUSIONS).toContain("rationaleEvidenceRefs");
  });

  it("binds the policy contract digest so a revised vocabulary is a new decision", () => {
    const wider = capturePolicyContract(
      registry({ exclusionReasonCodes: ["below-rank-limit", "ineligible-license", "operator-removed"] }),
      handlerRef,
    );
    expect(policyContractDigest(wider)).not.toBe(policyContractDigest(contract));
    expect(authorSelectionDecision(input({ contract: wider })).selectionDigest)
      .not.toBe(authorSelectionDecision(input()).selectionDigest);
  });

  it("refuses candidate identities delivered through an accessor", () => {
    const hostile: string[] = ["s1", "s2"];
    Object.defineProperty(hostile, "2", { get: () => "s3", enumerable: true, configurable: true });
    expectCode({ candidateIds: hostile }, "invalid-selection");
  });
});
