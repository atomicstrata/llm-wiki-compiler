/**
 * @file src/workflows/list.ts
 * @description The read-only `list` operation over a project's declared workflows.
 *
 * Surfaces the workflows declared in the active profile's `workflows` block as
 * lightweight summaries (id + stage ids in declared order). This is a pure read:
 * it loads the profile and projects it, creating nothing and taking no lock. A
 * default-profile project (which declares no workflows) yields an empty list.
 */

import { loadProfile } from "../profile/load.js";

/** A declared workflow surfaced to the list operation. */
export interface WorkflowSummary {
  /** The slug-safe id of the declared workflow. */
  workflowId: string;
  /** The workflow's stage ids, in declared order. */
  stageIds: string[];
}

/**
 * List the workflows declared in the project's profile.
 *
 * Loads the active profile and maps each declared workflow to a summary of its
 * id and stage ids (in declared order). The result is sorted by `workflowId` for
 * deterministic output. A project on the default profile (which declares no
 * `workflows`) yields an empty array.
 *
 * @param root - Absolute project root.
 * @returns The declared workflow summaries, sorted by `workflowId`.
 */
export async function listWorkflows(root: string): Promise<WorkflowSummary[]> {
  const { profile } = await loadProfile(root);
  const workflows = profile.workflows ?? {};
  return Object.entries(workflows)
    .map(([workflowId, def]) => ({ workflowId, stageIds: def.stages.map((stage) => stage.id) }))
    .sort((a, b) => a.workflowId.localeCompare(b.workflowId));
}
