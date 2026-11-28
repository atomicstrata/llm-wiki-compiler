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
export type { AnswerCitation, AnswerCitationReport } from "./citations/answer-types.js";
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

// Single-node scaling additions (expected scale, local catalog, batch compile, portable project path).
export { initWikiCore } from "./sdk/core.js";
export { ScaleRefusalError } from "./scale/contracts.js";
export { ScaleGateError } from "./scale/gate.js";
export { ScaleDowngradeError } from "./scale/downgrade-contracts.js";
export type { InitWikiOptions } from "./sdk/core-types.js";
export type { WikiScaleSurface, SdkScaleSetInput, InitProjectResult } from "./sdk/scale-facade.js";
export type { SdkScaleDowngradeInput, WikiScaleDowngradeSurface, WikiScaleArchivesSurface, ScaleTransitionPreviewV1, ScaleDowngradePreviewV1, DowngradeApplyResultV1, DowngradePlanV1, ScaleArchiveV1, ScaleDowngradeCode, DowngradeBlockerV1, DowngradeNoticeCode } from "./sdk/scale-facade.js";
export type { ScaleReport, ScaleReadiness } from "./scale/transition.js";
export type { ScaleRequest, ScaleRecordV1, ScalePlan, ScaleRefusalCode, RequestedScaleV1, ActiveArchitectureV1, PreparePendingV1, UnavailablePendingV1, StepRecordV1, LocalArchitecture, PlannedArchitecture, EnvelopeBound, MissingBackend, PreparationStepName, StepStatus, EstimateBasis } from "./scale/contracts.js";
export type { ScaleGateBlock } from "./scale/gate.js";
export type { ScaleRecord, ScaleRecordV2, ScalePlanV2, LocalArchitectureV2, PlannedArchitectureV2, MissingBackendV2, IneligibleReason, StepNameV2, StepRecordV2, ActiveArchitectureV2, PreparePendingV2, UnavailablePendingV2, DowngradePendingV2, DowngradeTarget } from "./scale/contracts-v2.js";
export type { WikiCatalogSurface, CatalogStatusV1, CatalogSyncReportV1, IndexedVerificationV1, StoreCheckV1, CatalogListingNote, CatalogCounts, IndexedStorageV1, StorageInventoryV1, GcApplyV1, GcDeletedV1, GcPlanStoreV1, GcPlanV1, GcPreviewV1, IndexedGcErrorCode, IndexedPinsV1, IndexedBackupReceiptV1, IndexedRestoreReceiptV1, IndexedRestoreErrorCode, RunRetirePreviewV1, RunRetirePlanV1, RunRetirePlanCandidateV1, RunRetirePlanCleanupV1, RunRetireApplyV1, RunRetireDoneV1, RunRetiredV1, IndexedRunsErrorCode, RunEntryV1, RunClassV1 } from "./sdk/catalog-facade.js";
export { openProject, registerProject } from "./portable/index.js";
export type { OpenProjectOptions, ProjectRegistration, ProjectSelector, TransportCredential } from "./portable/index.js";
export type { HostModel } from "./portable/project/runtime.js";
export type { ProviderOverride } from "./utils/provider.js";
export type * from "./portable/project/api.js";
export type * from "./portable/contracts.js";
export { openPagedProject } from "./portable/scale/open.js";
export type { OpenPagedProjectOptions } from "./portable/scale/open.js";
export { PAGED_REFUSAL_CODES_V2, SCALE_PROTOCOL_V2 } from "./portable/scale/contracts.js";
export type * from "./portable/scale/contracts.js";
export { SCOPE_FENCES_CAPABILITY, SCOPED_HOST_CEILINGS, SCOPED_PROTOCOL_V2 } from "./portable/scoped/contracts.js";
export type * from "./portable/scoped/contracts.js";
export { adoptProjectFormat2, openDiskScopedProject } from "./portable/scoped-disk/open.js";
export type { DiskScopedSessionV2, OpenDiskScopedProjectOptions } from "./portable/scoped-disk/open.js";
export type { AdoptionResult } from "./portable/host/format-adoption.js";
export { DISK_SCOPED_CAPABILITY, DISK_SCOPED_CEILINGS, DISK_SCOPED_PROTOCOL_V2 } from "./portable/scoped-disk/disk-contracts.js";
export type * from "./portable/scoped-disk/disk-contracts.js";
export { exportToFile, openOriginalsProject } from "./portable/originals/open.js";
export type { OpenOriginalsOptions } from "./portable/originals/open.js";
export type { OriginalsClientV2, StageOutcomeV2 } from "./portable/originals/client.js";
export type { Frame } from "./portable/originals/frames.js";
export { ORIGINALS_CAPABILITY, ORIGINALS_LIMITS, ORIGINALS_PROTOCOL_V2 } from "./portable/originals/contracts.js";
export type * from "./portable/originals/contracts.js";
export { openTieredProject } from "./portable/tiered/open.js";
export type { OpenTieredOptions, TieredReviewV2, TieredSessionV2 } from "./portable/tiered/open.js";
export { TIERS_CAPABILITY, TIERS_LIMITS, TIERS_PROTOCOL_V2 } from "./portable/tiered/contracts.js";
export type * from "./portable/tiered/contracts.js";
export { DETACHED_CAPABILITY, DETACHED_LIMITS, DETACHED_PROTOCOL_V2 } from "./portable/detached/contracts.js";
export type * from "./portable/detached/contracts.js";
export { openFederation, type OpenFederationOptions } from "./portable/federation/open.js";
export { FEDERATION_CAPABILITY, FEDERATION_LIMITS, FEDERATION_PROTOCOL_V2 } from "./portable/federation/contracts.js";
export type * from "./portable/federation/contracts.js";
export type { BatchCompileSummaryV1, BatchCountersV1, BatchPhase } from "./compiler/batch/contracts.js";
