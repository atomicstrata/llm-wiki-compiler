/**
 * @file src/local-workflows/show.ts
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

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { lookupWorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { UnknownWorkflowError } from "./start-operation.js";
import type {
  HumanInputDescriptorV1, SubjectGateDescriptorV1, WorkflowStageDef,
} from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** One stage's declared contract, surfaced to the `show` operation. */
export interface WorkflowStageDetail {
  /** The slug-safe stage id. */
  id: string;
  /** Declared entity-type ids this stage reads. */
  reads: string[];
  /** Declared entity-type ids this stage writes. */
  writes: string[];
  /** Declarative operator-input contract, when this stage parks for input. */
  humanInput?: HumanInputDescriptorV1;
  /** The stage's `<kind>:<id>` gate, when declared. */
  gate?: string;
  /** Verified predecessor subject required by the gate. */
  subjectGate?: SubjectGateDescriptorV1;
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
    ...(stage.humanInput !== undefined ? { humanInput: stage.humanInput } : {}),
    ...(stage.gate !== undefined ? { gate: stage.gate } : {}),
    ...(stage.subjectGate !== undefined ? { subjectGate: stage.subjectGate } : {}),
    ...(stage.previousIds !== undefined ? { previousIds: stage.previousIds } : {}),
  };
}

/** Read one workflow declaration through the supplied compiler host. */
export async function showWorkflowWithHost(host: LocalWorkflowHost, root: string, workflowId: string): Promise<WorkflowDetail> {
  const { profile } = await host.profiles.load(root);
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
