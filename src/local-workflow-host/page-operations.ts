/**
 * @file src/local-workflow-host/page-operations.ts
 * @description Compiler-owned page planning, typed validation and authorized
 * application for the local engine. The host guards the transaction; these
 * private implementation functions never acquire a second project lock.
 */
import { planPageMutation, type PlannedMutation } from "../trust/planner.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { validateLiveTypedPage } from "../trust/typed-page-validate.js";

/** Domain intent only; no caller-supplied permission or decision is accepted. */
export interface LocalWorkflowPageIntent {
  entityType: string;
  slug: string;
  body: string;
}

/** Preserve the existing review-routed, nonprivileged workflow planning origin. */
export function planLocalWorkflowPage(root: string, output: LocalWorkflowPageIntent) {
  return planPageMutation({
    root, target: { kind: "entity", entityType: output.entityType, slug: output.slug },
    body: output.body, origin: "workflow", reviewRouted: true,
  });
}

/** Recheck the active typed field, lifecycle and relation/artifact preconditions. */
export async function validateLocalWorkflowPage(root: string, output: LocalWorkflowPageIntent): Promise<void> {
  const loaded = await loadNonDefaultProfile(root);
  const def = loaded?.profile.entities[output.entityType];
  if (!loaded || !def) return;
  await validateLiveTypedPage({
    root, profile: loaded.profile, entityType: output.entityType,
    slug: output.slug, body: output.body, def,
  });
}

/** Apply through the existing under-lock executor, which reasserts the write floor. */
export function applyLocalWorkflowPage(root: string, planned: PlannedMutation[]) {
  if (!planned.every(mutation => mutation.kind === "page")) {
    throw new Error("local workflow page application requires page mutations");
  }
  return applyApprovedMutationsLocked(root, planned);
}
