/**
 * @file test/preparations/task7-entry-points.ts
 * @description The classification table behind the Task 7 capture invariant.
 * EVERY exported entry point of the five host-authority modules is listed here
 * as a probe or named in {@link CAPTURE_EXEMPT} with a reason. The invariant test
 * enumerates the modules' real exports and fails when one is unclassified, so a
 * future entry point cannot quietly skip the canonical capture discipline.
 */

import { deriveCompleteness } from "../../src/preparations/completeness.js";
import * as completeness from "../../src/preparations/completeness.js";
import * as proposalsModule from "../../src/preparations/proposals.js";
import * as reconciliation from "../../src/preparations/reconciliation.js";
import * as selection from "../../src/preparations/selection.js";
import * as intentCompiler from "../../src/preparations/intent-compiler.js";
import { decideReconciliation, reconciliationSetDigest } from "../../src/preparations/reconciliation.js";
import { authorSelectionDecision } from "../../src/preparations/selection.js";
import {
  HANDLER_DIGEST, baseRequest, compiler, contract, evidence,
  identitySetRef, pageTarget, proposals, sets,
} from "./task7-fixture.js";
import type { GateProofSummaryV1 } from "../../src/preparations/run-types.js";
import type { Sha256Digest } from "../../src/preparations/types.js";

/** One classified entry point and the hostile inputs it must refuse. */
export interface EntryProbe {
  readonly name: string;
  readonly invoke: (input: unknown) => unknown;
  /** A well-formed record-shaped input, when the entry point takes one. */
  readonly record?: () => Record<string, unknown>;
  /** A well-formed container input, when the entry point takes one directly. */
  readonly container?: () => unknown[];
  /** The list-valued fields of {@link record}; each must reject an array-like. */
  readonly containerFields?: readonly string[];
}

/**
 * Exports that are deliberately NOT capture probes, each with the reason it
 * cannot forge a record: an error constructor, a scalar-only lookup, or a
 * zero-argument factory whose real entry point is probed through its method.
 */
export const CAPTURE_EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  resolutionForDecision: "takes one scalar decision string, no record or container",
  createOperationIntentCompilerV1: "zero-argument factory; its compile method is probed",
  captureIntentRequest: "probed through the compile method it backs",
});

/** The five Task 7 host-authority modules whose exports must be classified. */
export const TASK7_MODULES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  completeness, proposals: proposalsModule, reconciliation, selection, intentCompiler,
});

const PLAN_DIGEST = `sha256:${"7".repeat(64)}` as Sha256Digest;
const PHASE_DIGEST = `sha256:${"8".repeat(64)}` as Sha256Digest;
const AUTHORITY_DIGEST = `sha256:${"9".repeat(64)}` as Sha256Digest;

const identitySets = sets({
  planned: ["a"], eligible: ["a"], attempted: ["a"], completed: ["a"], included: ["a"],
});

const classInput = {
  classId: "c1", disposition: "required" as const, identitySetRef, identitySets,
};

const derivation = deriveCompleteness({ scopeId: "s", classes: [classInput] });

const decided = decideReconciliation({
  reconciliationId: "accept-facts", contract, proposals,
  proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "accept",
  reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
});

const pending = decideReconciliation({
  reconciliationId: "escalate", contract, proposals,
  proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "needs-operator",
  reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
});

/** A deferral, so the compile probe actually reads `requiredProposalIds`. */
const deferred = decideReconciliation({
  reconciliationId: "hold", contract, proposals,
  proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "defer",
  reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
});

const selectionArgs = {
  selectionId: "sel-1", contract, candidateSetRef: evidence, candidateIds: ["a", "b"],
  eligibilityPolicyDigest: HANDLER_DIGEST, selectionLimit: 1, selectedIds: ["a"],
  excluded: [{ candidateId: "b", reasonCodes: ["below-rank-limit"] }],
  rationaleEvidenceRefs: [], producedBy: "host-policy" as const,
};

const decision = authorSelectionDecision(selectionArgs);

const proof: GateProofSummaryV1 = {
  gateProofId: `gpf_${"a".repeat(64)}` as GateProofSummaryV1["gateProofId"],
  gateId: "review-preparation", decision: "approved", decisionIndex: 0,
  planDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST,
  inputDigest: reconciliationSetDigest([pending]), authorityDigest: AUTHORITY_DIGEST,
  actor: { kind: "operator", id: "op-1" } as unknown as GateProofSummaryV1["actor"],
  at: "2026-07-20T00:00:00.000Z",
};

const CONTRACT_VOCABULARIES = Object.freeze([
  "exclusionReasonCodes", "reconciliationReasonCodes", "proposalKinds",
] as const);

/** The completeness-module probes. */
const COMPLETENESS_PROBES: readonly EntryProbe[] = Object.freeze([
  {
    name: "captureIdentitySets", invoke: (input) => completeness.captureIdentitySets(input),
    record: () => ({ ...identitySets }), containerFields: ["planned", "eligible", "included"],
  },
  {
    name: "assertIdentitySetEquations", invoke: (input) =>
      completeness.assertIdentitySetEquations(input as never),
    record: () => ({ ...identitySets }), containerFields: ["planned", "eligible", "included"],
  },
  {
    name: "deriveCompleteness", invoke: (input) => deriveCompleteness(input as never),
    record: () => ({ scopeId: "s", classes: [classInput] }), containerFields: ["classes"],
  },
  {
    name: "assertCompletenessPermitsSuccess", invoke: (input) =>
      completeness.assertCompletenessPermitsSuccess(input as never),
    record: () => ({ ...derivation.record }), containerFields: ["classes"],
  },
  {
    name: "completenessTotal", invoke: (input) =>
      completeness.completenessTotal(input as never, "planned"),
    record: () => ({ ...derivation.record }), containerFields: ["classes"],
  },
  {
    name: "toRunCompletenessRecord", invoke: (input) =>
      completeness.toRunCompletenessRecord(input as never),
    record: () => ({ ...derivation.record }), containerFields: ["classes"],
  },
  {
    name: "toRunCompletionWarning", invoke: (input) =>
      completeness.toRunCompletionWarning(input as never),
    record: () => ({
      code: completeness.OPTIONAL_DEFICIT_CODE, classId: "c1", deficitCount: 0,
      deficitIdentities: [], identityDigest: HANDLER_DIGEST,
      attempted: 1, completed: 1, skipped: 0, failed: 0,
    }),
    containerFields: [],
  },
  {
    name: "compareProviderCompletionClaim", invoke: (input) =>
      completeness.compareProviderCompletionClaim(input as never),
    record: () => ({ claim: {}, derived: derivation.record }), containerFields: [],
  },
]);

/** The proposal-, reconciliation-, selection-, and compiler-module probes. */
const AUTHORITY_PROBES: readonly EntryProbe[] = Object.freeze([
  {
    name: "normalizeProviderProposals", invoke: (input) =>
      proposalsModule.normalizeProviderProposals(input as never),
    record: () => ({
      contract, attemptId: proposals[0] === undefined ? "" : `pat_${"4".repeat(64)}`,
      providerPinDigest: `sha256:${"2".repeat(64)}`, sourceEvidenceRefs: [evidence],
      drafts: [{ proposalKind: "entity-fact", proposedValue: 1 }],
    }),
    containerFields: ["sourceEvidenceRefs", "drafts"],
  },
  {
    name: "assertProposalAuthentic", invoke: (input) =>
      proposalsModule.assertProposalAuthentic(input),
    record: () => ({ ...proposals[0]! }), containerFields: ["sourceEvidenceRefs"],
  },
  {
    name: "decideReconciliation", invoke: (input) => decideReconciliation(input as never),
    record: () => ({
      reconciliationId: "r", contract, proposals,
      proposalIds: [proposals[0]!.proposalId], decision: "accept",
      reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
    }),
    containerFields: ["proposals", "proposalIds", "reasonCodes", "evidenceRefs"],
  },
  {
    name: "reconciliationPolicyDigest", invoke: (input) =>
      reconciliation.reconciliationPolicyDigest(input as never, "accept", ["duplicate-entity"]),
    record: () => ({ ...contract }), containerFields: [...CONTRACT_VOCABULARIES],
  },
  {
    name: "assertReconciliationAuthentic", invoke: (input) =>
      reconciliation.assertReconciliationAuthentic(input, contract),
    record: () => ({ ...decided }),
    containerFields: ["proposalIds", "reasonCodes", "evidenceRefs"],
  },
  {
    name: "pendingOperatorReconciliations", invoke: (input) =>
      reconciliation.pendingOperatorReconciliations(input as never),
    container: () => [decided],
  },
  {
    name: "reconciliationSetDigest", invoke: (input) => reconciliationSetDigest(input as never),
    container: () => [pending],
  },
  {
    name: "assertReconciliationsSettled", invoke: (input) =>
      reconciliation.assertReconciliationsSettled(input as never),
    record: () => ({
      records: [pending], gateProofs: [proof], gateId: "review-preparation",
      currentPlanDigest: PLAN_DIGEST, phaseDigest: PHASE_DIGEST, authorityDigest: AUTHORITY_DIGEST,
    }),
    containerFields: ["records", "gateProofs"],
  },
  {
    name: "assertDeferPermitted", invoke: (input) =>
      reconciliation.assertDeferPermitted(input as never),
    record: () => ({ records: [decided], requiredProposalIds: [] }),
    containerFields: ["records", "requiredProposalIds"],
  },
  {
    name: "capturePolicyContract", invoke: (input) =>
      selection.capturePolicyContract({ resolve: () => input as never }, {
        handlerId: "compile", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST,
      } as never),
    record: () => ({ ...contract }), containerFields: [...CONTRACT_VOCABULARIES],
  },
  {
    name: "assertCapturedPolicyContract", invoke: (input) =>
      selection.assertCapturedPolicyContract(input),
    record: () => ({ ...contract }), containerFields: [...CONTRACT_VOCABULARIES],
  },
  {
    name: "policyContractDigest", invoke: (input) =>
      selection.policyContractDigest(input as never),
    record: () => ({ ...contract }), containerFields: [...CONTRACT_VOCABULARIES],
  },
  {
    name: "authorSelectionDecision", invoke: (input) => authorSelectionDecision(input as never),
    record: () => ({ ...selectionArgs }),
    containerFields: ["candidateIds", "selectedIds", "excluded", "rationaleEvidenceRefs"],
  },
  {
    name: "assertSelectionDecisionAuthentic", invoke: (input) =>
      selection.assertSelectionDecisionAuthentic(input),
    record: () => ({ ...decision }),
    containerFields: ["selectedIds", "excluded", "rationaleEvidenceRefs"],
  },
  {
    name: "compile", invoke: (input) => compiler.compile(input as never),
    // Defers with an authoritatively-empty required set: the positive control
    // compiles, and the hostile-container probe exercises requiredProposalIds
    // reaching the COMPILER, not only the direct assertDeferPermitted call.
    record: () => ({
      ...baseRequest({
        targets: [pageTarget("ada")], reconciliations: [deferred], requiredProposalIds: [],
      }),
    }),
    containerFields: ["targets", "proposals", "reconciliations", "selections", "requiredProposalIds"],
  },
]);

/** Every classified Task 7 entry-point probe. */
export const ENTRY_PROBES: readonly EntryProbe[] =
  Object.freeze([...COMPLETENESS_PROBES, ...AUTHORITY_PROBES]);
