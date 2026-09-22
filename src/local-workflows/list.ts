/**
 * @file src/local-workflows/list.ts
 * @description The read-only `list` operation over a project's declared workflows.
 *
 * Surfaces the workflows declared in the active profile's `workflows` block as
 * lightweight summaries (id + stage ids in declared order). This is a pure read:
 * it loads the profile and projects it, creating nothing and taking no lock. A
 * default-profile project (which declares no workflows) yields an empty list.
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** A declared workflow surfaced to the list operation. */
export interface WorkflowSummary {
  /** The slug-safe id of the declared workflow. */
  workflowId: string;
  /** The workflow's stage ids, in declared order. */
  stageIds: string[];
}

/** Discover workflow declarations through the supplied host's passive profile reader. */
export async function listWorkflowsWithHost(host: LocalWorkflowHost, root: string): Promise<WorkflowSummary[]> {
  const { profile } = await host.profiles.load(root);
  const workflows = profile.workflows ?? {};
  return Object.entries(workflows)
    .map(([workflowId, def]) => ({ workflowId, stageIds: def.stages.map((stage) => stage.id) }))
    .sort((a, b) => a.workflowId.localeCompare(b.workflowId));
}
