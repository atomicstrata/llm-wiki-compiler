/**
 * @file test/preparations/plan-fixture.ts
 * @description One complete, independently mutable valid normalized preparation
 * plan used across the Task 1 parser, graph, bounds, and schedule suites. Every
 * negative test clones this object, mutates one field, and asserts fail-closed
 * rejection, so the positive baseline stays trustworthy.
 */

import { MILESTONE_A_DESIGN_DIGEST } from "../../src/preparations/constants.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** Default per-instance phase bounds; individual tests override as needed. */
function phaseBounds(): Record<string, number> {
  return {
    maximumAttempts: 2, maximumInvocationsPerAttempt: 1, maximumBrokerRequestsPerAttempt: 0,
    maximumEffectsPerAttempt: 0, maximumTransitionsPerInstance: 4, maximumOutputEvidenceBytes: 1024,
    maximumCheckpointBytes: 0, maximumTokensPerAttempt: 100, maximumTimeMsPerInstance: 1000,
    maximumCostMicrosPerAttempt: 10,
  };
}

/** Build one complete, deeply independent valid plan object. */
export function validPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1, executionMode: "durable-preparation", atomicityClass: "local-bundle-only",
    workspaceId: "research",
    knowledgeAuthority: { id: "knowledge", version: "1.0.0", digest: DIGEST, runtimeIdentityDigest: DIGEST },
    operationsAuthority: { id: "ops", version: "1.0.0", digest: DIGEST, runtimeIdentityDigest: DIGEST },
    actionAuthority: {
      actionId: "compile", actionDescriptorDigest: DIGEST, handlerContractDigest: DIGEST,
      requestedSurface: "cli", capabilityClassCeiling: "read-only",
    },
    recipeDigest: DIGEST,
    initialInputSet: {
      kind: "seed", mediaType: "application/json", provenanceLabel: "caller", digest: DIGEST,
      byteCount: 4, sensitivity: "ordinary", retention: "until-handoff",
      producer: { kind: "host", contractDigest: DIGEST }, untrusted: true,
    },
    phases: [
      {
        logicalPhaseId: "collect", role: "work", dependsOn: [], disposition: "required",
        executor: { kind: "provider-capability", providerPinDigest: DIGEST, capabilityId: "gather", capabilityContractDigest: DIGEST },
        inputBindings: [{ bindingId: "seed", sourceKind: "initial-input" }],
        expansion: { kind: "single" }, bounds: phaseBounds(),
      },
      {
        logicalPhaseId: "expand", role: "work", dependsOn: ["collect"], disposition: "required",
        executor: { kind: "host-handler", handlerId: "expander", handlerContractVersion: "1", handlerContractDigest: DIGEST },
        inputBindings: [{ bindingId: "collected", sourceKind: "phase-output", sourcePhaseId: "collect" }],
        expansion: {
          kind: "map", sourceEvidenceBinding: "collected", maximumItems: 4,
          itemIdentity: "canonical-item-digest", duplicateDisposition: "deduplicate",
          overflowDisposition: { kind: "count-as-incomplete", completenessClassId: "overflow" },
        },
        bounds: phaseBounds(),
      },
      {
        logicalPhaseId: "review", role: "gate", dependsOn: ["expand"], disposition: "required",
        gate: { gateId: "review", gateKind: "review-preparation" },
        inputBindings: [{ bindingId: "expanded", sourceKind: "phase-output", sourcePhaseId: "expand" }],
        expansion: { kind: "single" }, bounds: phaseBounds(),
      },
      {
        logicalPhaseId: "join", role: "join", dependsOn: ["review"], disposition: "required",
        inputBindings: [{ bindingId: "gated", sourceKind: "phase-output", sourcePhaseId: "review" }],
        expansion: { kind: "single" }, bounds: phaseBounds(),
      },
    ],
    outputContract: {
      producingPhaseIds: ["join"],
      handoffCapacity: {
        milestoneADesignDigest: MILESTONE_A_DESIGN_DIGEST,
        includedEvidenceClasses: [{ classId: "review", maximumItems: 10, maximumItemBytes: 1_048_576, maximumAggregateBytes: 4_194_304 }],
        maximumBundlePayloadBytes: 33_554_432, maximumManifestBytes: 1_048_576,
        maximumRunEvidenceItemBytes: 131_072, maximumRunEvidenceBytes: 8_388_608,
        maximumActiveStoreContributionBytes: 268_435_456,
      },
    },
    bounds: {
      maximumPhaseInstances: 7, maximumAttempts: 14, maximumInvocations: 14, maximumBrokerRequests: 0,
      maximumEffects: 0, maximumTransitions: 28, maximumEvidenceRefs: 21, maximumEvidenceBytes: 7168,
      maximumCheckpointBytes: 0, maximumTokens: 1400, maximumTimeMs: 7000, maximumCostMicros: 140,
    },
    safetyFloorDigest: DIGEST,
  };
}

/** Serialize a plan object exactly as a durable plan document is stored. */
export function planText(plan: Record<string, unknown>): string {
  return JSON.stringify(plan);
}
