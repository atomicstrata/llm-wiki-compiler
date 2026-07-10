/**
 * @file src/workflows/show.ts
 * @description The read-only `show` operation over ONE declared workflow.
 *
 * Where `list` surfaces only each workflow's id + stage ids, `show` surfaces the
 * full per-stage contract an agent/operator needs to drive the workflow: each
 * stage's `reads`/`writes`/`gate`/`previousIds`, the workflow's `projectionFile`,
 * and the declared workflow ACTIONS that target it. A pure read: it loads the
 * profile and projects it, creating nothing and taking no lock. An unknown
 * workflow id fails closed with {@link UnknownWorkflowError} (never a silent
 * empty), mirroring `start`'s fail-closed lookup.
 */

import { loadProfile } from "../profile/load.js";
import { lookupWorkflowDef, UnknownWorkflowError } from "./start.js";
import type { WorkflowStageDef } from "../profile/types.js";

/** One stage's declared contract, surfaced to the `show` operation. */
export interface WorkflowStageDetail {
  /** The slug-safe stage id. */
  id: string;
  /** Declared entity-type ids this stage reads. */
  reads: string[];
  /** Declared entity-type ids this stage writes. */
  writes: string[];
  /** The stage's `<kind>:<id>` gate, when declared. */
  gate?: string;
  /** Prior stage ids this stage was renamed FROM, when declared. */
  previousIds?: string[];
}

/** A declared workflow's full detail: its stages, projection target, and actions. */
export interface WorkflowDetail {
  /** The slug-safe id of the declared workflow. */
  workflowId: string;
  /** Each stage's declared contract (reads/writes/gate/previousIds), in order. */
  stages: WorkflowStageDetail[];
  /** The workflow's declared markdown projection target, when one exists. */
  projectionFile?: string;
  /** The ids of declared workflow actions that target this workflow. */
  actions: string[];
}

/** Project one stage def to its surfaced detail, omitting absent optional fields. */
function toStageDetail(stage: WorkflowStageDef): WorkflowStageDetail {
  return {
    id: stage.id,
    reads: stage.reads,
    writes: stage.writes,
    ...(stage.gate !== undefined ? { gate: stage.gate } : {}),
    ...(stage.previousIds !== undefined ? { previousIds: stage.previousIds } : {}),
  };
}

/**
 * Show ONE declared workflow's full detail.
 *
 * Loads the active profile and resolves the named workflow via the OWN-property
 * lookup ({@link lookupWorkflowDef}); an undeclared id fails closed with
 * {@link UnknownWorkflowError} rather than returning an empty result. Surfaces each
 * stage's `reads`/`writes`/`gate`/`previousIds`, the workflow's `projectionFile`,
 * and the ids of every declared workflow action whose `workflow` targets this id.
 * Read-only: no lock, no write.
 *
 * @param root - Absolute project root.
 * @param workflowId - The declared workflow id to show.
 * @returns The workflow's full detail.
 * @throws {UnknownWorkflowError} When `workflowId` is not a declared workflow.
 */
export async function showWorkflow(root: string, workflowId: string): Promise<WorkflowDetail> {
  const { profile } = await loadProfile(root);
  const def = lookupWorkflowDef(profile.workflows, workflowId);
  if (def === undefined) throw new UnknownWorkflowError(workflowId);
  const actions = Object.entries(profile.workflowActions ?? {})
    .filter(([, action]) => action.workflow === workflowId)
    .map(([actionId]) => actionId)
    .sort((a, b) => a.localeCompare(b));
  return {
    workflowId,
    stages: def.stages.map(toStageDetail),
    ...(def.projectionFile !== undefined ? { projectionFile: def.projectionFile } : {}),
    actions,
  };
}
