/**
 * Mandatory artifact checks composed into a REAL TrustDecision — the mirror of
 * planRelationMutation, so the artifact ApplyResult and audit event carry a composed
 * decision, never a hardcoded literal. Not review-routed (like relations): a block
 * composes to deny. The grant is an AUTHORITY gate applied by the executor arm on
 * top of this decision, not a trust check.
 */
import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import { composeTrustDecision, checkFromProblems, type TrustCheckResult, type TrustDecision } from "../trust/decision.js";
import { validateArtifactBody } from "./body-contract.js";

/** Composed decisions that permit a live artifact write. */
export const ARTIFACT_LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

export interface ArtifactPlanResult { decision: TrustDecision; checks: TrustCheckResult[]; def?: ArtifactTypeDef; }

/** Run the mandatory checks and compose. `def` is present only when the type is declared. */
export function planArtifactMutation(profile: ProfilePack, mutation: ArtifactPlannedMutation): ArtifactPlanResult {
  const def = profile.artifacts?.[mutation.artifactType];
  if (!def) {
    const checks = [checkFromProblems("artifact-type-declared",
      [`artifact type ${JSON.stringify(mutation.artifactType)} is not declared by the active profile`])];
    return { decision: composeTrustDecision(checks, { reviewRouted: false }), checks };
  }
  const checks = [
    checkFromProblems("artifact-type-declared", []),
    checkFromProblems("artifact-body-contract", validateArtifactBody(def, mutation.body)),
  ];
  return { decision: composeTrustDecision(checks, { reviewRouted: false }), checks, def };
}
