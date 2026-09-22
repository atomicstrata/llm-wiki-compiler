/**
 * @file src/local-workflows/projection.ts
 * @description A DERIVED, one-way markdown projection of a workflow run.
 *
 * A workflow run is core-owned JSON (the SOURCE OF TRUTH, persisted under the
 * private `.llmwiki/` dir; see `./store.js`). When a workflow def declares a
 * `projectionFile` (a `wiki/...` path confined under `wiki/` at profile-load),
 * `workflow project` renders a human-readable markdown view of the run to that
 * path. The projection is DERIVED: it is computed FROM the run JSON and is a
 * `wiki/` OUTPUT, not run state. Editing the markdown can NEVER affect the run —
 * nothing in this module (or in validation/read) ever consumes the markdown back
 * into a record; every status/read path reads the run JSON, never the projection.
 *
 * ## Confinement (no page-clobber)
 * The profile validator confines `projectionFile` to the RESERVED projection
 * subtree (`wiki/outputs/workflows/`) at LOAD, so a `projectionFile` can never
 * name an authored entity page. On top of that, the resolved write path is
 * RE-CONFINED here ({@link confineProjectionPath}) before it reaches
 * {@link atomicWrite}: a path that escapes `<root>/wiki/` fails CLOSED. As a final
 * defense in depth, {@link writeProjection} refuses to overwrite a target that
 * EXISTS but is NOT already a projection (no `<!-- DERIVED from the workflow run
 * JSON` marker, read NO-FOLLOW) — so even within the reserved subtree an authored
 * file is never clobbered (a prior projection IS overwritable: the normal
 * re-project). The write goes through `atomicWrite({ confineRoot })`, the same
 * leaf-symlink-hardened primitive every `wiki/` writer uses.
 */

import { buildFrontmatter } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { ProjectionResult } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
export type { ProjectionResult } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** Header marking rendered run text as derived, never authoritative input. */
const DERIVED_HEADER = "<!-- DERIVED from the workflow run JSON; edits here do NOT affect run state. -->";

/**
 * Render the run's append-only stage log as one markdown bullet per entry, in
 * order (`- <stageId>: <status>`). Pure and deterministic.
 *
 * @param run - The run whose `stageLog` is rendered.
 * @returns The stage-log lines joined by newlines (empty string for no stages).
 */
function renderStageLog(run: WorkflowRun): string {
  return run.stageLog.map((entry) => `- ${entry.stageId}: ${entry.status}`).join("\n");
}

/**
 * Render a workflow run as a DERIVED markdown projection.
 *
 * PURE and deterministic. Frontmatter (built via the shared {@link buildFrontmatter}
 * so the YAML is vetted/consistent) carries the run's identity + position +
 * inputs/outputs; the body is the {@link DERIVED_HEADER} followed by a `## Stage
 * Log` section with one line per `stageLog` entry, in order.
 *
 * This is a ONE-WAY view: the markdown is DERIVED from the run JSON and is never
 * read back into run state — editing it cannot mutate the run.
 *
 * @param run - The core-owned run record (the source of truth).
 * @returns The markdown projection (frontmatter + derived header + stage log).
 */
export function projectRun(run: WorkflowRun): string {
  const frontmatter = buildFrontmatter({
    workflow: run.workflowId,
    runId: run.runId,
    status: run.status,
    currentStage: run.currentStage,
    // STAMP the run's monotonic state version so a reader/lint can detect a STALE
    // projection (this stamped version < the run's current stateVersion).
    stateVersion: run.stateVersion,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    inputs: run.inputs,
    outputs: run.outputs,
  });
  return `${frontmatter}\n\n${DERIVED_HEADER}\n\n## Stage Log\n\n${renderStageLog(run)}\n`;
}

/** Project a retained run using only the supplied host's bounded read/write services. */
export async function writeProjectionWithHost(host: LocalWorkflowHost, root: string, runId: string): Promise<ProjectionResult> {
  const read = await host.history.read(root, runId);
  if (read.status !== "ok") {
    return { status: "unavailable", detail: read.status === "absent" ? "run-absent" : read.detail };
  }
  return host.projections.write(root, read.run.workflowId, projectRun(read.run));
}

/**
 * BEST-EFFORT auto-project hook: regenerate the projection for a just-mutated run
 * so a declared `projectionFile` stays FRESH after every state-mutating op
 * (advance/gate/cancel/fail/resume/submit/adapt) instead of silently going stale.
 *
 * Called by the ops AFTER the run write succeeds (never under the lock-failure
 * path): a projection-write failure must NOT fail the op, so EVERY error here is
 * SWALLOWED (logged once to stderr) — the run is already durably committed, and a
 * stale projection is a degraded read-surface, not a lost mutation. A workflow with
 * no `projectionFile` is a `no-target` no-op, so parity is preserved (a default
 * project declares none, so nothing is ever written and behavior is unchanged).
 *
 * @param root - Absolute project root.
 * @param run - The freshly persisted run record to re-project.
 */
export async function maybeAutoProject(root: string, run: WorkflowRun,
  project: (root: string, run: WorkflowRun) => Promise<ProjectionResult>): Promise<void> {
  try {
    await project(root, run);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[33mwarning:\x1b[0m auto-projection failed for run ${run.runId}: ${detail}`);
  }
}
