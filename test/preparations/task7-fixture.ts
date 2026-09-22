/**
 * @file test/preparations/task7-fixture.ts
 * @description Shared fixture for the Wave O3 Task 7 host-authority regression
 * and invariant suites: one registered policy contract, one normalized proposal
 * set, one clean completeness record, and a compilation request whose every
 * field is host-authored. Each regression perturbs exactly one dimension of it.
 */

import {
  OPERATION_MUTATION_KINDS, createOperationAdapterRegistry, type OperationAdapterSet,
} from "../../src/operation-bundles/adapter-registry.js";
import type { OperationStoreAdapter } from "../../src/operation-bundles/adapter-types.js";
import { mintBundleId } from "../../src/operation-bundles/ids.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { deriveCompleteness, type PreparationCompletenessV1 } from "../../src/preparations/completeness.js";
import {
  createOperationIntentCompilerV1, type HostMutationTargetV1, type IntentCompilationRequestV1,
} from "../../src/preparations/intent-compiler.js";
import { normalizeProviderProposals } from "../../src/preparations/proposals.js";
import { decideReconciliation } from "../../src/preparations/reconciliation.js";
import { capturePolicyContract, type PreparationPolicyContractV1 } from "../../src/preparations/selection.js";
import type { AttemptId } from "../../src/preparations/ids.js";
import type { EvidenceRefV1, Sha256Digest } from "../../src/preparations/types.js";

export const HANDLER_DIGEST = `sha256:${"1".repeat(64)}` as Sha256Digest;
export const PROVIDER_PIN = `sha256:${"2".repeat(64)}` as Sha256Digest;
const PAGE_DIGEST = `sha256:${"3".repeat(64)}` as Sha256Digest;
export const ATTEMPT = `pat_${"4".repeat(64)}` as AttemptId;

export const evidence: EvidenceRefV1 = {
  kind: "provider-output", mediaType: "application/json", provenanceLabel: "provider-output",
  digest: parseSha256Digest(`sha256:${"5".repeat(64)}`), byteCount: 32, sensitivity: "ordinary",
  retention: "until-handoff",
  producer: { kind: "provider", providerPinDigest: PROVIDER_PIN, attemptId: ATTEMPT },
  untrusted: true,
};

/** The registered host-handler policy contract every fixture decision cites. */
export const contract = capturePolicyContract({
  resolve: (): PreparationPolicyContractV1 => ({
    handlerId: "compile", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST,
    exclusionReasonCodes: ["below-rank-limit"], reconciliationReasonCodes: ["duplicate-entity"],
    proposalKinds: ["entity-fact"],
  }),
}, { handlerId: "compile", handlerContractVersion: "1.0.0", handlerContractDigest: HANDLER_DIGEST });

export const proposals = normalizeProviderProposals({
  contract, attemptId: ATTEMPT, providerPinDigest: PROVIDER_PIN, sourceEvidenceRefs: [evidence],
  drafts: [{
    proposalKind: "entity-fact", targetLogicalIdentity: "entity:person:ada",
    proposedValue: { born: 1815 },
  }],
});

/** A never-invoked adapter proving compilation reaches no authoritative store. */
function stubAdapter(kind: OperationStoreAdapter["kind"]): OperationStoreAdapter {
  const refuse = async (): Promise<never> => { throw new Error("adapter invoked"); };
  return { kind, preflight: refuse, observe: refuse, apply: refuse, verify: refuse };
}

export const adapters = createOperationAdapterRegistry(Object.fromEntries(
  OPERATION_MUTATION_KINDS.map((kind) => [kind, stubAdapter(kind)]),
) as unknown as OperationAdapterSet);

/** One host-authored page target; the path lives here, never in provider text. */
export function pageTarget(slug: string, overrides: Partial<HostMutationTargetV1> = {}): HostMutationTargetV1 {
  return {
    logicalIdentity: `entity:person:${slug}`,
    draft: {
      kind: "page", operation: "create", target: { kind: "entity", entityType: "person", slug },
      payloadRef: "3".repeat(64), precondition: { kind: "absent" },
      postcondition: { digest: PAGE_DIGEST, byteCount: 42 },
    },
    ...overrides,
  };
}

/** Build one identity-set record over the eleven closed categories. */
export function sets(over: Record<string, string[]> = {}): Record<string, string[]> {
  return {
    planned: [], eligible: [], attempted: [], completed: [], included: [], skipped: [],
    unavailable: [], failed: [], cancelled: [], overflow: [], nonConverged: [], ...over,
  };
}

export const identitySetRef: EvidenceRefV1 = { ...evidence, kind: "completeness-identity-set" };

const cleanCompleteness: PreparationCompletenessV1 = deriveCompleteness({
  scopeId: "compile", classes: [{
    classId: "entity-facts", disposition: "required", identitySetRef,
    identitySets: sets({
      planned: ["ada"], eligible: ["ada"], attempted: ["ada"], completed: ["ada"], included: ["ada"],
    }),
  }],
}).record;

export const compiler = createOperationIntentCompilerV1();

/** Build one fully host-authored compilation request over the fixture evidence. */
export function baseRequest(
  overrides: Partial<IntentCompilationRequestV1> = {},
): IntentCompilationRequestV1 {
  return {
    bundleId: mintBundleId(), adapters, contract, proposals, selections: [],
    targets: [pageTarget("ada")],
    reconciliations: [decideReconciliation({
      reconciliationId: "accept-facts", contract, proposals,
      proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "accept",
      reasonCodes: ["duplicate-entity"], evidenceRefs: [evidence],
    })],
    completeness: cleanCompleteness, ...overrides,
  };
}
