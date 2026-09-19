/**
 * Engine-free knowledge SDK and existing domain integration exports.
 * Core retains authenticated local history without exporting its execution
 * engine. The standard compiler separately composes the legacy workflow API.
 */
export { createWikiCore } from "./sdk/core.js";
export type { WikiCore } from "./sdk/core-types.js";
export type {
  Page,
  PageRef,
  PageDirectory,
  ListPagesOptions,
  ListPagesResult,
  ListPagesProfileBlock,
} from "./pages/list.js";
export type {
  JsonExportDocument,
  ExportJsonOptions,
  JsonExportProfileBlock,
  RelationView,
} from "./export/json-export.js";
export {
  ProviderUnavailableError,
  UnknownProviderError,
} from "./utils/provider-guard.js";
export { startViewer, type StartViewerOptions } from "./viewer/server.js";
export type {
  ViewerDeps, LiveStageProjectionProvider, LiveStageProjectionResult,
  VerifiedStageFactsV1, VerifiedExperimentStateV1, RunProjectionAnchor,
  WorkflowRunProjectionEnvelope, WorkflowRunProblem, StageProjection,
  StageGateProjection, StageGateState, StageOutputRef,
  StageVerificationFailureV1, VerifiedFactPanelV1,
} from "./viewer/workflow-run-projection.js";
export type { RecordIntentV1 } from "./operation-bundles/record-intent.js";
export type { PreparedEffectRefV1 } from "./operation-bundles/prepare-record.js";
export type { SdkOperationOptions, WikiOperationSurface, RecordPreparationResultV1 } from "./sdk/operations-facade.js";
export type { CreateWikiOptions, SdkCompileOptions, ContextPackOptions } from "./sdk/core-types.js";
export type { IngestResult, CompileResult, QueryResult } from "./utils/types.js";
export type { IngestTextInput } from "./commands/ingest.js";
export type { LintSummary } from "./linter/types.js";
export type { TieredLintReportV1, LintTierV1 } from "./linter/tiers.js";
export type { ContextPack } from "./context/types.js";
export type { EvalReport } from "./eval/types.js";
export type { WikiStatus } from "./status/collect.js";
export type { PageRecord } from "./pages/read.js";
export type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "./sources/store.js";
export type { WriteStatus } from "./utils/types.js";
export type { OkfExportReport } from "./export/okf/run.js";
export type { OkfImportReport, OkfImportSkip, OkfImportedPage } from "./import/run.js";
export { LockUnavailableError, QueueFullError } from "./import/run-errors.js";
export type { SdkWriteArtifactInput } from "./sdk/core-types.js";
export type { ArtifactRef } from "./artifacts/ref.js";
export type { ArtifactHealth } from "./artifacts/resolve.js";
export { ArtifactVerifyUnavailableError } from "./artifacts/resolve.js";
export type { VerifiedArtifactBodyV1 } from "./artifacts/read-verified.js";
export type { ArtifactSelectorV1, ArtifactDiscoveryV1 } from "./artifacts/discover.js";
export type { ArtifactMemberFileInput } from "./artifacts/members.js";
export type { SdkStageEntityPageInput } from "./trust/staging.js";
export { StagingRequiresProfileError } from "./trust/staging.js";
export type {
  StagedChange,
  CandidateKind,
  HeldReasonCode,
  WorkflowRunRef,
  StagedRelationRef,
  StagedArtifactRef,
} from "./trust/staged-change.js";
export type { AppendRelationInput } from "./relations/store.js";
export type { RelationRef, RelationId, CitationRef } from "./relations/types.js";
export { RelationEndpointError } from "./relations/types.js";
export { RelationWriteDeniedError, RelationsRequireProfileError } from "./trust/relation-write.js";
export type { SdkTransitionLifecycleInput } from "./sdk/core-types.js";
export { LifecycleTransitionUnavailableError } from "./trust/lifecycle-transition.js";
export { LifecycleTransitionError } from "./profile/lifecycle.js";
export type {
  EntityRef,
  RawPageRef,
  MutationTarget,
  MutationOperation,
  MutationKind,
  PlannedMutation,
  MutationProvenance,
} from "./trust/planner.js";
export type { TrustDecision } from "./trust/decision.js";
export { activeProfileDigest, readConfinedCappedBuffer } from "./sdk/domain-read.js";
export type { ConfinedCappedRead } from "./sdk/domain-read.js";
export { loadNonDefaultProfile } from "./profile/block.js";
export type {
  ProfilePack,
  EntityId,
  EntityPageRef,
  EntityPageView,
  EntityProblemView,
  LoadedProfile,
  SlugSafe,
} from "./profile/types.js";
export { parseFrontmatter, slugify } from "./utils/markdown.js";
export { collectViewerPages, resolveBareSlug } from "./viewer/collect.js";
export type { ArtifactMemberEntry } from "./artifacts/members.js";
export { isTrustedWriteGranted } from "./trust/trusted-write.js";
export { captureVerifiedMemberArtifact } from "./artifacts/capture-member.js";
export { assertRunWorkspace, WorkflowProcessAuthorityError } from "./workflow-history/process-authority.js";
export type { WorkflowProcessAuthorityV1, WorkflowRefusalV1, WorkflowRun } from "./workflow-history/types.js";
export { atomicWrite, AtomicWriteCollisionError, AtomicWriteCommittedCleanupError, type AtomicWriteOptions, type AtomicWriteNoReplaceDurableOptions } from "./utils/atomic-write.js";
export type { SdkPreparationOptions, SdkStagePreparationInput } from "./sdk/core-types.js";
export type { CancelResultV1 as PreparationCancelResult, FailResultV1 as PreparationFailResult, ListResultV1 as PreparationListResult, PreparationGrant, PreparationLifecyclePendingState as PreparationLifecycleState, PreparationRunRowV1 as PreparationRunRow, PreparationRunState, PreviewResultV1 as PreparationPreviewResult, RecoveryResultV1 as PreparationRecoveryResult, StageResultV1 as PreparationStageResult } from "./preparations/service.js";
export { PrincipalAuthorityError } from "./preparations/service.js";
export type { SdkProductActionInput, SdkProductResumeInput, WikiProductSurface } from "./sdk/core-types.js";
export type { CompiledActionSummaryV1 as ProductActionSummary, ProductInvokeResultV1 as ProductInvokeResult, ProductPreviewResultV1 as ProductPreviewResult } from "./products/service.js";
export { locatePreparationManifest, readPreparationInitialInput, resolvePreparationRun, readPreparationRunForManifest } from "./preparations/service-run-lookup.js";
export { classifyExecutionOwnerLiveness } from "./preparations/attempts/lease.js";
export { scanPreparationInventory } from "./preparations/capacity.js";
export type { PreparationInitialInputLookupV1, PreparationManifestLookupV1, PreparationRunLookupV1 } from "./preparations/service-run-lookup.js";
export { readPreparationEvidenceBytes } from "./preparations/evidence-store.js";
export type { PreparationManifestV1 } from "./preparations/manifest-parse.js";
export { preparationManifestDigest } from "./preparations/manifest-parse.js";
export type { PhaseSummaryV1 as PreparationPhaseSummary } from "./preparations/run-types.js";
export { observeOperationBundle } from "./operation-bundles/observe.js";
export type { OperationBundleObservationV1, OperationBundleMutationV1, OperationPageObservationV1 } from "./operation-bundles/observe.js";
export type { EvidenceRefV1 as PreparationEvidenceRef } from "./preparations/types.js";
export { runPreparation } from "./preparations/runner.js";
export type { RunPreparationInputV1 as RunPreparationInput, RunPreparationResultV1 as RunPreparationResult, PreparationMaterializerV1 as PreparationMaterializer } from "./preparations/runner.js";
export { formatArtifactRef, parseArtifactRef } from "./artifacts/ref.js";
export { readVerifiedArtifactBody } from "./artifacts/read-verified.js";
export { resolveArtifactRef } from "./artifacts/resolve.js";
export { artifactPaths, memberLeafPath, readArtifactMemberBytes } from "./artifacts/store.js";
export { loadProfile } from "./profile/load.js";
export { isSlugSafe } from "./profile/identity.js";
export type { ProfileTemplatePackage } from "./profile/templates/types.js";
export { confineUnderRoot } from "./utils/path-confine.js";
export { resolveConfinedPrivateDir } from "./utils/private-dir.js";
export { releaseLock } from "./utils/lock.js";
export { acquireMutationLockBlocking } from "./operation-bundles/lock-gate.js";
export { recomputeCompositionLock } from "./operations-packs/composition-lock.js";
export { parseOperationsPack } from "./operations-packs/parse.js";
export type { PackRecipeV2 } from "./operations-packs/recipe-types.js";
export type { WorkspaceOperationsPackV2 } from "./operations-packs/types.js";
export { HOST_DECLARED_CONTRACT_SET, defaultHostCompatibility } from "./products/compatibility.js";
export { assertProductDigest } from "./products/ids.js";
export type { Sha256Digest } from "./products/ids.js";
export { recomputePackageDigest, recomputeRuntimeAuthorityDigest } from "./products/packages/verify.js";
export type { PackageMemberKind, PackageMemberRefV1, ProductPackageManifestV1 } from "./products/types.js";
export { transitionLifecycle } from "./trust/lifecycle-transition.js";
export { readRun } from "./workflow-history/store.js";
export { assertCurrentWorkflowProcessAuthority } from "./workflow-history/process-authority.js";
export { readLiveTargetDigest } from "./local-workflow-host/live-target.js";
export { DEV_PROVIDER_BOUNDS, derivePinForPayload, devEffectiveGrantRequest, devGrantScope, devModelInvokeAuthority, devProviderInvocation, devSourceReadAuthority, installDevProvider, issueDevProviderGrant } from "./capability-providers/host/index.js";
export type { DevGrantRequestContextV1, DevInvocationHostV1, InstallDevProviderRequestV1, InstalledDevProviderV1, IssueDevGrantRequestV1, IssuedDevGrantV1, ProviderBackendChannelV1, ProviderHostBackendV1, ProviderLaunchDescriptorV1 } from "./capability-providers/host/index.js";
export { resolveAuthorizedProviderPaths } from "./capability-providers/packages/paths.js";
export { canonicalBytes, canonicalDigest } from "./profile/templates/signing/canonical.js";
export { resolveProviderEntrypoint, providerLaunchEnv } from "./capability-providers/host/entrypoint.js";
export { hostModelQuoteDigest } from "./capability-providers/brokers/model.js";
export type { HostModelBrokerV1, HostModelQuoteObservationV1, HostModelQuoteRequestV1 } from "./capability-providers/brokers/model.js";
export { confinedFetch, confinedFetchRequest } from "./connectors/confined-fetch.js";
export type { FetchLimits, ConfinedFetchSeams, ConfinedFetchResult, ConfinedFetchRequest, ConfinedFetchMethod } from "./connectors/confined-fetch.js";
export { scaffoldConfinedDirectories, ensureConfinedDirectory, type ScaffoldDirectoriesResultV1 } from "./utils/confined-scaffold.js";
