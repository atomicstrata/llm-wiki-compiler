/**
 * @file src/workflow-history/definition.ts
 * @description Pure definition lookup and lifecycle classification shared by readers and execution.
 */
import type { WorkflowDef } from "../profile/types.js";
import type { WorkflowRun } from "./types.js";


/**
 * Look up a workflow def by id using an OWN-property check, never the prototype
 * chain. A plain `workflows?.[id]` resolves inherited `Object.prototype` members
 * (`constructor`, `valueOf`, …), so an attacker-chosen id like `"constructor"`
 * would yield the `Function` constructor instead of `undefined` and crash a
 * downstream `.map`/digest with a raw `TypeError`. {@link Object.hasOwn} confines
 * the lookup to declared workflow ids, so an undeclared id is cleanly `undefined`.
 *
 * @param workflows - The profile's optional `workflows` block.
 * @param workflowId - The candidate workflow id (possibly attacker-controlled).
 * @returns The declared def, or `undefined` when not an OWN key.
 */
export function lookupWorkflowDef(
  workflows: Record<string, WorkflowDef> | undefined,
  workflowId: string,
): WorkflowDef | undefined {
  const declared = workflows ?? {};
  return Object.hasOwn(declared, workflowId) ? declared[workflowId] : undefined;
}


/**
 * Map an old stage id to its current id: identity when the id is still a stage,
 * else the id of the stage that declares it under `previousIds`, else `null`
 * (unmappable — the stage was removed, not renamed). Pure and total.
 *
 * @param oldId - The stage id referenced by an in-flight run.
 * @param def - The CURRENT workflow definition to map against.
 * @returns The current stage id `oldId` maps to, or `null` when unmappable.
 */
export function mapStageId(oldId: string, def: WorkflowDef): string | null {
  if (def.stages.some((stage) => stage.id === oldId)) return oldId;
  const renamed = def.stages.find((stage) => stage.previousIds?.includes(oldId));
  return renamed?.id ?? null;
}


/** The run statuses that are terminal (no further lifecycle action). */
const TERMINAL_STATUSES = ["completed", "cancelled", "failed", "refused"] as const;


/** True when `status` is a terminal run status. */
export function isTerminalStatus(status: WorkflowRun["status"]): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
