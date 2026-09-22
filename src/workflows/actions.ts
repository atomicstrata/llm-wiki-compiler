/**
 * Standard-distribution compatibility entry points for actions.
 * Host construction stays here; optional engine operations receive a host.
 */
export { lookupAction, listActionsWithHost, showActionWithHost } from "@atomicstrata/llmwiki-local-workflows";
export type { ActionSummary, ActionDetail } from "@atomicstrata/llmwiki-local-workflows";
import { listActionsWithHost, showActionWithHost } from "@atomicstrata/llmwiki-local-workflows";
import { createLocalWorkflowHost } from "./host.js";
import type { ActionSummary, ActionDetail } from "@atomicstrata/llmwiki-local-workflows";


/**
 * List the workflow actions declared in the project's profile.
 *
 * Loads the active profile and maps each declared `workflowActions` entry to a
 * summary, sorted by `actionId` for deterministic output. A default-profile
 * project (which declares no `workflowActions`) yields an empty array.
 *
 * @param root - Absolute project root.
 * @returns The declared action summaries, sorted by `actionId`.
 */
export async function listActions(root: string): Promise<ActionSummary[]> {
  return listActionsWithHost(createLocalWorkflowHost(), root);
}


/**
 * Show one declared workflow action, including its effective per-surface
 * permission. The action is resolved by an OWN-property check (never the
 * prototype chain), so an undeclared id — including `"constructor"` — fails
 * closed with {@link UnknownActionError}. Read-only: loads the profile + the
 * confined local config, creating nothing and taking no lock.
 *
 * @param root - Absolute project root.
 * @param actionId - The declared action id to show.
 * @returns The action detail with computed `effectivePermissions`.
 * @throws {UnknownActionError} When the id is not a declared OWN action key.
 */
export async function showAction(root: string, actionId: string): Promise<ActionDetail> {
  return showActionWithHost(createLocalWorkflowHost(), root, actionId);
}
