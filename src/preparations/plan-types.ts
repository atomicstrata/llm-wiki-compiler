/**
 * @file src/preparations/plan-types.ts
 * @description The closed version-one normalized preparation plan grammar
 * (design sections 10.1 through 10.3). The Spec 3 compiler produces this
 * runtime object; the loader in `plan-parse.ts` rebuilds it field by field.
 * The plan carries no raw credential, absolute path, provider source path,
 * executable bytes, shell string, arbitrary URL authority, prompt-defined
 * tool, or pack-supplied code — every executor and handler is a pinned digest.
 */

import type { PageEvidenceDescriptorV2 } from "../operations-packs/recipe-types.js";
import type { MILESTONE_A_DESIGN_DIGEST } from "./constants.js";
import type {
  ActionAuthorityRefV1,
  AuthorityRefV1,
  EvidenceRefV1,
  Sha256Digest,
  WorkflowParentRefV1,
} from "./types.js";

export type PreparationExecutionMode = "ephemeral-read" | "durable-preparation";

export type PreparationAtomicityClass =
  | "local-bundle-only"
  | "external-effect-only"
  | "non-atomic-external-before-local";

export type PhaseRole = "work" | "gate" | "join";

export type PhaseDisposition = "required" | "optional";

/** The eight closed gate kinds (design section 17.1). */
export type PhaseGateKind =
  | "confirm-input-exposure"
  | "confirm-cost"
  | "confirm-external-effect"
  | "confirm-residual-risk"
  | "review-selection"
  | "review-preparation"
  | "discussion-checkpoint"
  | "confirm-abandonment";

/**
 * One field a provider phase is SEALED to return: its id and the value kind the
 * plan admits for it. A successor decodes the provider's answer against this
 * rather than against the provider's own claim about its shape, so what a
 * provider is allowed to return was fixed when the plan was approved.
 */
export interface PhaseOutputFieldV1 {
  fieldId: string;
  valueKind: string;
}

/** The sealed source-evidence descriptor a provider-capability executor may carry. */
/**
 * Provider input keys the host assembly OWNS: `request` carries the rendered
 * request and `templateRef` its template pin. A path table sealed under either
 * would be silently overwritten at invocation, so every surface that admits a
 * `pathTableKey` — compiler, pack grammar, and untrusted plan grammar — refuses
 * them from this ONE set.
 */
export const RESERVED_PROVIDER_INPUT_KEYS: ReadonlySet<string> = new Set(["request", "templateRef"]);

export interface PlanSourceEvidenceDescriptorV1 {
  readonly pathsField: string;
  readonly digestsField: string;
  readonly byteCountsField: string;
  readonly inputIdPrefix: string;
  readonly kind: string;
  readonly provenanceLabel: string;
  readonly mediaType: string;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pathTableKey: string;
}

/** The plan-sealed artifact-evidence declaration (see recipe-types.ts). */
/**
 * The sealed page-evidence declaration (P5c §2a), plan-side. The shape is the
 * pack grammar's own — the closed capture-form union is already structural —
 * so the plan aliases it rather than re-declaring a drifting copy.
 */
export type PlanPageEvidenceDescriptorV1 = PageEvidenceDescriptorV2;

export interface PlanArtifactEvidenceDescriptorV1 {
  readonly refField: string;
  readonly memberNamesField: string;
  readonly memberDigestsField: string;
  readonly memberByteCountsField: string;
  readonly inputIdPrefix: string;
  readonly kind: string;
  readonly provenanceLabel: string;
  readonly mediaType: string;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pathTableKey: string;
}

/** A pinned provider-capability or host-handler executor for a work phase. */
export type PhaseExecutorV1 =
  | {
      kind: "provider-capability";
      providerPinDigest: Sha256Digest;
      capabilityId: string;
      capabilityContractDigest: Sha256Digest;
      /**
       * The declared output contract, sealed so a successor can decode it.
       *
       * OPTIONAL because plans are PERSISTED: a run staged before this field
       * existed carries a provider phase with no sealed schema, and such a plan
       * must still parse. Chaining from one is refused by name at the read seam
       * rather than decoded against a guess.
       */
      outputSchema?: PhaseOutputFieldV1[];
      maximumOutputItems?: number;
      /**
       * The template that renders the request this provider is ASKED.
       *
       * Sealed for the same reason the output schema is: what a provider is
       * asked is part of what an operator approved. Without it the runtime has
       * no way to reach the request, and a host would have to invent one — at
       * which point the plan digest stops describing the invocation.
       */
      requestTemplateRef?: string;
      /**
       * The sealed source-evidence descriptor (spec §2.1 generic change 1),
       * beside `requestTemplateRef` deliberately: the two together are the
       * complete sealed statement of what a provider may READ and what it is
       * ASKED. Optional because plans are persisted — a plan written before
       * this field existed parses unchanged and resolves to no source-evidence
       * inputs, exactly the behaviour it was approved under.
       */
      sourceEvidenceDescriptor?: PlanSourceEvidenceDescriptorV1;
      artifactEvidenceDescriptor?: PlanArtifactEvidenceDescriptorV1;
      pageEvidenceDescriptor?: PlanPageEvidenceDescriptorV1;
    }
  | {
      kind: "host-handler";
      handlerId: string;
      handlerContractVersion: string;
      handlerContractDigest: Sha256Digest;
    };

/** How one phase binds an input: the frozen initial set or a predecessor output. */
export interface PhaseInputBindingV1 {
  bindingId: string;
  sourceKind: "initial-input" | "phase-output";
  sourcePhaseId?: string;
}

/** The disposition applied when a bounded expansion overflows or fails to converge. */
export type ExpansionDeficitDisposition =
  | { kind: "fail-closed" }
  | { kind: "count-as-incomplete"; completenessClassId: string };

/** The one declared continuation rule of a bounded-repeat expansion. */
export type RepeatContinuationV1 =
  | { kind: "fixed-count"; count: number }
  | { kind: "until-empty"; outputField: string }
  | { kind: "while-boolean"; outputField: string; continueValue: boolean };

/** The three closed expansion policies (design section 10.3). */
export type PhaseExpansionV1 =
  | { kind: "single" }
  | {
      kind: "map";
      sourceEvidenceBinding: string;
      maximumItems: number;
      itemIdentity: "host-id" | "canonical-item-digest";
      duplicateDisposition: "deduplicate" | "fail";
      overflowDisposition: ExpansionDeficitDisposition;
    }
  | {
      kind: "bounded-repeat";
      maximumIterations: number;
      continuation: RepeatContinuationV1;
      limitDisposition: ExpansionDeficitDisposition;
    };

/** A closed host gate contract attached to a `gate` phase (design section 17.1). */
export interface PhaseGateContractV1 {
  gateId: string;
  gateKind: PhaseGateKind;
}

/** The declared worst-case envelope for one materialized phase instance. */
export interface PhaseBoundsV1 {
  maximumAttempts: number;
  maximumInvocationsPerAttempt: number;
  maximumBrokerRequestsPerAttempt: number;
  maximumEffectsPerAttempt: number;
  maximumTransitionsPerInstance: number;
  maximumOutputEvidenceBytes: number;
  maximumCheckpointBytes: number;
  maximumTokensPerAttempt: number;
  maximumTimeMsPerInstance: number;
  maximumCostMicrosPerAttempt: number;
}

/** One normalized phase in the closed phase graph (design section 10.2). */
export interface NormalizedPhaseV1 {
  logicalPhaseId: string;
  role: PhaseRole;
  dependsOn: string[];
  disposition: PhaseDisposition;
  executor?: PhaseExecutorV1;
  inputBindings: PhaseInputBindingV1[];
  outputSchemaDigest?: Sha256Digest;
  expansion: PhaseExpansionV1;
  gate?: PhaseGateContractV1;
  brokerPlanDigest?: Sha256Digest;
  effectPlanDigest?: Sha256Digest;
  bounds: PhaseBoundsV1;
}

/** One evidence class admitted into the handed-off Milestone A bundle. */
export interface HandoffEvidenceClassV1 {
  classId: string;
  maximumItems: number;
  maximumItemBytes: number;
  maximumAggregateBytes: number;
}

/** The closed downstream capacity contract for a handoff-capable plan (10.1). */
export interface HandoffCapacityPlanV1 {
  milestoneADesignDigest: typeof MILESTONE_A_DESIGN_DIGEST;
  includedEvidenceClasses: HandoffEvidenceClassV1[];
  maximumBundlePayloadBytes: number;
  maximumManifestBytes: number;
  maximumRunEvidenceItemBytes: number;
  maximumRunEvidenceBytes: number;
  maximumActiveStoreContributionBytes: number;
  /**
   * Materialization limits for RUNNER-managed plans (runner design v3 §6):
   * the finalization step persists exactly one materialization manifest plus
   * its payload objects, and that overhead must be reserved at stage time or a
   * plan admitted exactly at its evidence bounds completes all work and then
   * cannot finalize. OPTIONAL as a triple so existing schema-v1 plans keep
   * parsing: the reservation applies only when ALL THREE are declared, and the
   * runner separately refuses missing-or-partial declarations at entry —
   * partial is a refusal state, never an accounting state.
   */
  maximumMaterializationManifestBytes?: number;
  maximumMaterializationPayloadRefs?: number;
  maximumMaterializationPayloadBytes?: number;
}

/** The declared output contract: which phases produce it and its handoff subset. */
export interface PreparationOutputContractV1 {
  producingPhaseIds: string[];
  handoffCapacity?: HandoffCapacityPlanV1;
}

/** The declared worst-case run envelope, checked against the graph and ceilings. */
export interface PreparationBoundsV1 {
  maximumPhaseInstances: number;
  maximumAttempts: number;
  maximumInvocations: number;
  maximumBrokerRequests: number;
  maximumEffects: number;
  maximumTransitions: number;
  maximumEvidenceRefs: number;
  maximumEvidenceBytes: number;
  maximumCheckpointBytes: number;
  maximumTokens: number;
  maximumTimeMs: number;
  maximumCostMicros: number;
}

/** The closed runtime normalized preparation plan (design section 10.1). */
export interface NormalizedPreparationPlanV1 {
  schemaVersion: 1;
  executionMode: PreparationExecutionMode;
  atomicityClass: PreparationAtomicityClass;
  workspaceId: string;
  knowledgeAuthority: AuthorityRefV1;
  operationsAuthority: AuthorityRefV1;
  actionAuthority: ActionAuthorityRefV1;
  recipeDigest: Sha256Digest;
  workflowParent?: WorkflowParentRefV1;
  initialInputSet: EvidenceRefV1;
  phases: NormalizedPhaseV1[];
  outputContract: PreparationOutputContractV1;
  bounds: PreparationBoundsV1;
  safetyFloorDigest: Sha256Digest;
  supersedesPreparationId?: string;
}
