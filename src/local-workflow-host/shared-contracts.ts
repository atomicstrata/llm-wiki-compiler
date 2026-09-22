/**
 * Version-locked integration contracts for the optional local workflow engine.
 * Only named types, error identities and in-memory policy/encoding helpers are
 * exported here. Domain effects and observations require the constructed host;
 * this entry point exports no store writers, executors or host factory.
 */
export { assertRawInputJsonWithinBounds, assertInputDepthWithinBounds, WorkflowInputBoundsError } from "../utils/workflow-input-bounds.js";
export { ArtifactWriteDeniedError, ArtifactWriteRefusedError } from "../artifacts/apply.js";
export { ArtifactPreconditionUnmetError } from "../artifacts/enforce-precondition.js";
export type { ArtifactMemberFileInput } from "../artifacts/members.js";
export { formatArtifactRef, parseArtifactRef } from "../artifacts/ref.js";
export type { ArtifactRef } from "../artifacts/ref.js";
export { hashArtifactBody } from "../artifacts/store.js";
export { CAPABILITY_ORDER, SURFACE_HARD_CAP, canSatisfyHumanGate, effectivePermission } from "./authority.js";
export { assertLocalWorkflowCoreInstance } from "./contracts.js";
export type { LocalWorkflowTransaction } from "./contracts.js";
export type { LocalWorkflowHost } from "./host-contract.js";
export { nonInteractiveHumanGateIo } from "./human-gate-confirm.js";
export type { HumanGateIo } from "./human-gate-confirm.js";
export type { LocalWorkflowObservations } from "./observations.js";
export type { readLocalWorkflowProcessSource } from "./process-source.js";
export type { ProjectionResult } from "./projection.js";
export { WorkflowRunIdError, serializeRunWithinCap } from "./run-codec.js";
export { WorkflowVerifierError } from "./verifier-error.js";
export { preparationManifestDigest } from "../preparations/manifest-parse.js";
export type { PreparationManifestV1 } from "../preparations/manifest-parse.js";
export type { PreparationRunV1 } from "../preparations/run-types.js";
export { EntityFieldContractError } from "../profile/field-contract.js";
export { isSlugSafe, parseEntityId } from "../profile/identity.js";
export { LifecycleTransitionError } from "../profile/lifecycle.js";
export { actionDefForPresentation, actionLabelForPresentation } from "../profile/presentation-trust.js";
export { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
export type { ActionInputField, ActionSurface, CapabilityClass, EntityId, EntityTypeDef, HumanInputDescriptorV1, HumanInputFieldV1, ProfilePack, SubjectGateDescriptorV1, WorkflowActionDef, WorkflowDef, WorkflowStageDef } from "../profile/types.js";
export { workflowDefDigest } from "../profile/workflow-digest.js";
export { RelationPreconditionUnmetError } from "../relations/enforce-precondition.js";
export type { AppendRelationInput } from "../relations/store.js";
export type { ApplyResult } from "../trust/apply-result.js";
export type { TrustDecision } from "../trust/decision.js";
export { allowedEvidence } from "../trust/lifecycle-body.js";
export type { ArtifactPlannedMutation, LifecycleTransitionPlannedMutation, PlanResult, RelationPlannedMutation } from "../trust/planner.js";
export { RelationWriteDeniedError } from "../trust/relation-apply.js";
export type { isTrustedWriteGranted } from "../trust/trusted-write.js";
export { AtomicWritePostCommitError } from "../utils/atomic-write.js";
export { MAX_ACTIVE_WORKFLOW_RUNS, MAX_MINT_ATTEMPTS, MAX_TOTAL_WORKFLOW_RUNS, MAX_WORKFLOW_DETAIL_CHARS, MAX_WORKFLOW_INPUTS_BYTES, MAX_WORKFLOW_INPUT_ARRAY_ITEMS, MAX_WORKFLOW_INPUT_DEPTH, MAX_WORKFLOW_INPUT_STRING_CHARS, MAX_WORKFLOW_LABEL_CHARS, MAX_WORKFLOW_RUN_EVENTS } from "../utils/constants.js";
export type { BlockingLockOptions } from "../utils/lock.js";
export { buildFrontmatter } from "../utils/markdown.js";
export { RuntimeCaptureError, deepCaptureData } from "../utils/runtime-capture.js";
export { isTerminalStatus, lookupWorkflowDef, mapStageId } from "../workflow-history/definition.js";
export { isTrustGate, parseGate } from "../workflow-history/gates.js";
export type { GateKind } from "../workflow-history/gates.js";
export { WORKFLOW_RUN_SCHEMA_VERSION } from "../workflow-history/types.js";
export type { PendingStageOutput, StageStatus, VerifierReceiptV1, WorkflowActorKind, WorkflowEvent, WorkflowProcessAuthorityV1, WorkflowRun } from "../workflow-history/types.js";
export { LOCAL_WORKFLOW_CORE_INSTANCE, LocalWorkflowCoreInstanceError, LocalWorkflowTransactionError } from "./contracts.js";
