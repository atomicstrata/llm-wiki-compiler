/**
 * Standard compatibility entry points for adapt.
 * The engine receives services; this facade constructs the compiler host.
 */
export { computeAdaptationPlan, adaptDryRunWithHost, adaptApplyWithHost, mapStageId, AdaptationKeyCollisionError, AdaptDryRunError } from "@atomicstrata/llmwiki-local-workflows";
export type { AdaptationPlan } from "@atomicstrata/llmwiki-local-workflows";
import { adaptDryRunWithHost, adaptApplyWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { AdaptationPlan } from "@atomicstrata/llmwiki-local-workflows";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";


/**
 * Compute the adaptation plan(s) for one run (by id) or every readable run —
 * READ-ONLY (no lock, no write). With a `runId`, an unresolvable id is a
 * fail-closed throw, AND a resolvable-but-unreadable leaf (corrupt/oversize/
 * planted) is ALSO a fail-visible throw — a caller-named run never silently
 * vanishes as `[]`. Without a `runId`, every readable run is planned and an
 * individual unreadable leaf is skipped (the intended skip-malformed bulk
 * behavior). An UNAVAILABLE run STORE is surfaced as a throw on both paths rather
 * than silently treated as "no runs".
 *
 * @param root - Absolute project root.
 * @param runId - When given, plan just this run; otherwise plan all readable runs.
 * @returns One {@link AdaptationPlan} per readable run.
 * @throws {AdaptDryRunError} On an unresolvable id, a named-but-unreadable run, or
 *   an unavailable run store.
 */
export async function adaptDryRun(root: string, runId?: string): Promise<AdaptationPlan[]> {
  return adaptDryRunWithHost(createLocalWorkflowHost(), root, runId);
}


/**
 * Apply a workflow-definition adaptation to a run, RE-ANCHORING it to the active
 * def UNDER THE PROJECT LOCK (fail-closed read via {@link withRunLock}). A TERMINAL
 * run (completed/cancelled/failed) throws {@link RunNotActiveError} — adapt never
 * re-anchors closed history or burns event budget on it, mirroring advance/cancel/
 * fail/gate. Loads the
 * profile and resolves the run's def — a REMOVED workflow throws
 * {@link UnknownWorkflowError} (no def to adapt to). An already-current run throws
 * {@link AlreadyCurrentError} (no-op). A LOSSY plan WITHOUT `confirm` throws
 * {@link AdaptationRequiresConfirmError} — fail closed, the run is UNCHANGED.
 * Otherwise it remaps + persists the run (a confirmed-lossy current-stage drop
 * cancels the run); a lossless adapt re-anchors so the result classifies `current`.
 *
 * @param root - Absolute project root.
 * @param runId - The run to re-anchor to the active def.
 * @param opts - `confirm:true` authorizes a lossy adaptation.
 * @returns The persisted, re-anchored run.
 * @throws {LockBusyError} When the project lock is held.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {RunNotActiveError} When the run is terminal (completed/cancelled/failed).
 * @throws {UnknownWorkflowError} When the run's workflow was removed from the profile.
 * @throws {AlreadyCurrentError} When the run already matches the active def.
 * @throws {AdaptationRequiresConfirmError} When the adaptation is lossy and unconfirmed.
 */
export async function adaptApply(
  root: string,
  runId: string,
  opts?: { confirm?: boolean },
): Promise<WorkflowRun> {
  return adaptApplyWithHost(createLocalWorkflowHost(), root, runId, opts);
}
