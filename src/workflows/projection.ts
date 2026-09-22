/**
 * Standard derived-run projection entry point. Rendering lives in the engine;
 * the compiler host retains confined output writing and profile observation.
 */
export { projectRun, writeProjectionWithHost, maybeAutoProject } from "@atomicstrata/llmwiki-local-workflows";
export type { ProjectionResult } from "@atomicstrata/llmwiki-local-workflows";
export { confineProjectionPath } from "@atomicstrata/llmwiki-core/compiler-cli";
import { writeProjectionWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { ProjectionResult } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/**
 * Write a run's DERIVED markdown projection to its workflow's declared
 * `projectionFile` under `wiki/`, returning a discriminated {@link ProjectionResult}.
 *
 * Reads the run JSON (`unavailable` — fail-visible — when absent/unreadable, so a
 * broken/unknown run is never silently skipped). Loads the active profile and the
 * run's workflow def; when the def is gone or declares no `projectionFile`, there
 * is nothing to write (`no-target`). The write path is RE-CONFINED under
 * `<root>/wiki/` (fail-closed on escape) before the atomic write. This is a
 * `wiki/` OUTPUT write only — it takes NO run lock and never mutates run state.
 *
 * @param root - Absolute project root.
 * @param runId - The run id whose projection to write.
 * @returns `written` with the project-relative path; `no-target` when nothing is
 *   declared; `unavailable` (with detail) when the run/store/path is fail-visible.
 */
export async function writeProjection(root: string, runId: string): Promise<ProjectionResult> {
  return writeProjectionWithHost(createLocalWorkflowHost(), root, runId);
}
