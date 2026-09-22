/**
 * Standard run-store compatibility exports. Core owns passive reads and signed
 * writes; the optional engine owns identifier generation and compaction policy.
 * Engine operations bind persistence through the constructed host transaction.
 */
export { mintRunId, terminalRunCandidates, WorkflowRunIdCollisionError } from "@atomicstrata/llmwiki-local-workflows";
export { writeRun } from "../local-workflow-host/run-store.js";
export { WorkflowRunIdError, WorkflowRunTooLargeError, serializeRunWithinCap } from "../local-workflow-host/run-codec.js";
export { readRun, listRuns, resolveRunId, runExists } from "../workflow-history/store.js";
export type { WorkflowRunRead, WorkflowRunList, RunIdResolution } from "../workflow-history/store.js";
