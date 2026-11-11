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
