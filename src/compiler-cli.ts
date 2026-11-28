/**
 * Version-locked support for the standard compiler CLI and MCP composition.
 * Exports existing command handlers and bounded read/presentation helpers;
 * registration and process orchestration stay in the standard distribution.
 * Each handler retains its existing operator, review and apply checks.
 */
export { classifyRun, workflowStatus, workflowStatusForWorkflow } from "./workflow-history/status.js";
export type { RunClassification, RunStatus } from "./workflow-history/status.js";
export { confirmHumanGateInteractively, nonInteractiveHumanGateIo } from "./local-workflow-host/human-gate-confirm.js";
export type { HumanGateIo } from "./local-workflow-host/human-gate-confirm.js";
export { confineProjectionPath } from "./local-workflow-host/projection.js";
export type { ArtifactRef } from "./artifacts/ref.js";
export { resolveArtifactRef, declaresArtifactTypes } from "./artifacts/resolve.js";
export { ingestSource } from "./commands/ingest.js";
export { generateAnswer } from "./commands/query.js";
export { compileAndReport } from "./compiler/index.js";
export { buildContextPack } from "./context/build.js";
export { runEval, DEFAULT_SAMPLE_SIZE } from "./eval/index.js";
export { loadPreviousReport, loadHistory } from "./eval/stats.js";
export { runOkfExport } from "./export/okf/run.js";
export { runOkfImport } from "./import/run.js";
export { lint } from "./linter/index.js";
export { listPageFileNames } from "./pages/file-names.js";
export { readPageContent, readPageRecord } from "./pages/read.js";
export { loadNonDefaultProfile } from "./profile/block.js";
export { isSlugSafe } from "./profile/identity.js";
export type { AppendRelationInput } from "./relations/store.js";
export { pickSearchRefs, loadSelectedRefs } from "./search/retrieval.js";
export { listSelectedSourceFiles } from "./sources/scan.js";
export { collectStatus } from "./status/collect.js";
export type { TrustDecision } from "./trust/decision.js";
export { CONCEPTS_DIR, INDEX_FILE, QUERIES_DIR, SOURCES_DIR, STATE_FILE } from "./utils/constants.js";
export { safeReadFile, parseFrontmatter } from "./utils/markdown.js";
export * as output from "./utils/output.js";
export { withQuiet } from "./utils/output.js";
export { confineUnderRoot } from "./utils/path-confine.js";
export { ensureCompileProviderAvailable, ensureProviderAvailable } from "./utils/provider-guard.js";
export { readStateClassified } from "./utils/state.js";

// Single-node scaling additions (expected scale, local catalog, batch compile, portable project path).
export { compileReportCommand } from "./commands/compile.js";
export { initCommand, scalePrepareCommand, scaleSetCommand, scaleStatusCommand } from "./commands/scale.js";
export { scaleArchiveListCommand, scaleArchiveReportCommand, scaleDowngradeCommand, scalePreviewCommand } from "./commands/scale-downgrade.js";
export type { ScaleArchiveCommandOptions, ScaleDowngradeCommandOptions, ScalePreviewCommandOptions } from "./commands/scale-downgrade.js";
export { assertScaleReady } from "./scale/gate.js";
export { assertCompileOptionsRoutable } from "./compiler/batch/route.js";
export type { InitCommandOptions, ScaleOutputOptions, ScalePrepareCommandOptions, ScaleSetCommandOptions } from "./commands/scale.js";
export { catalogPagesCommand, catalogSourcesCommand, catalogStatusCommand, catalogSyncCommand, catalogVerifyCommand } from "./commands/catalog.js";
export type { CatalogCommandOptions } from "./commands/catalog.js";
export { catalogBackupCommand, catalogGcCommand, catalogPinCommand, catalogPinsCommand, catalogRestoreCommand, catalogRunsCommand, catalogUnpinCommand } from "./commands/catalog-maintenance.js";
export type { CatalogGcCommandOptions, CatalogRunsCommandOptions } from "./commands/catalog-maintenance.js";
export { indexedCatalogNote, routedPageFileNames } from "./catalog/materialize.js";
export type { CatalogListingNote } from "./catalog/reads.js";
export { projectApplyCommand, projectApprovalShowCommand, projectApproveCommand, projectCandidatesListCommand, projectCandidatesShowCommand, projectCapabilitiesCommand, projectDeferredCommand, projectExportCommand, projectPagesListCommand, projectPagesReadCommand, projectProposeCommand, projectRegisterCommand, projectResolveCommand, projectSearchCommand, projectSourceAddCommand, projectStatusCommand, projectTicketIssueCommand, projectViewCommand } from "./commands/project/commands.js";
export { openCommandSession, type ProjectRef } from "./commands/project/session.js";
export { portableSurface, surfaceFailure } from "./portable/surfaces/surface.js";
export type { OpenSession, PortableSurface } from "./portable/surfaces/surface.js";
export { startPortableViewer } from "./portable/surfaces/viewer.js";
export { projectScaleCapabilitiesCommand, projectScaleOpenCommand, projectScalePagesCommand, projectScaleSearchCommand } from "./commands/project/scale-commands.js";
export { projectFormatAdoptCommand, projectScopedApplyCommand, projectScopedApproveCommand, projectScopedCandidatesListCommand, projectScopedCandidatesShowCommand, projectScopedCapabilitiesCommand, projectScopedCoverageCommand, projectScopedProposeCommand, projectScopedStatusCommand } from "./commands/project/scoped-commands.js";
export { projectOriginalsAddCommand, projectOriginalsExportCommand, projectOriginalsReadCommand, projectOriginalsStatCommand } from "./commands/project/originals-commands.js";
export { projectTiersApplyCommand, projectTiersApproveCommand, projectTiersPromoteCommand, projectTiersReviewCommand, projectTiersSearchCommand, projectTiersTriageCommand } from "./commands/project/tiers-commands.js";
export { projectFederationApplyCommand, projectFederationApproveCommand, projectFederationGroupCommand, projectFederationLinksCommand, projectFederationProposeCommand, projectFederationQualityCommand, projectFederationQueueCommand, projectFederationReadCommand, projectFederationReviewCommand, projectFederationSearchCommand } from "./commands/project/federation-commands.js";
export { pagedSurface } from "./portable/surfaces/paged-surface.js";
