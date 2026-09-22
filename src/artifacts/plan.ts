/**
 * Mandatory artifact checks composed into a REAL TrustDecision — the mirror of
 * planRelationMutation, so the artifact ApplyResult and audit event carry a composed
 * decision, never a hardcoded literal. Not review-routed (like relations): a block
 * composes to deny. The grant is an AUTHORITY gate applied by the executor arm on
 * top of this decision, not a trust check.
 *
 * MEMBER-BEARING TYPES derive their body HERE: the caller supplies member bytes
 * only, core renders the canonical manifest (src/artifacts/members.ts), and the
 * plan result carries that derived body as the bytes to write — the body
 * contract then re-validates it exactly as it validates any other body.
 */
import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import { composeTrustDecision, checkFromProblems, type TrustCheckResult, type TrustDecision } from "../trust/decision.js";
import { validateArtifactBody } from "./body-contract.js";
import { buildMemberManifest } from "./members.js";

/** Composed decisions that permit a live artifact write. */
export const ARTIFACT_LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

export interface ArtifactPlanResult {
  decision: TrustDecision;
  checks: TrustCheckResult[];
  def?: ArtifactTypeDef;
  /** The bytes the write lands: the caller's body, or the manifest core derived for a member-bearing type. */
  body?: string;
}

/** Resolve the bytes to write and the member-shape problems for `def`. */
function bodyFor(def: ArtifactTypeDef, mutation: ArtifactPlannedMutation): { body: string; problems: string[] } {
  if (def.members === undefined) {
    return mutation.memberFiles === undefined
      ? { body: mutation.body, problems: [] }
      : { body: mutation.body, problems: ["artifact type declares no members; memberFiles is not accepted"] };
  }
  if (mutation.memberFiles === undefined || mutation.body !== "") {
    return { body: mutation.body, problems: ["a member-bearing artifact type takes memberFiles (and an empty body); core derives the manifest"] };
  }
  const built = buildMemberManifest(def, mutation.memberFiles);
  return built.ok ? { body: built.body, problems: [] } : { body: mutation.body, problems: built.problems };
}

/** Run the mandatory checks and compose. `def` is present only when the type is declared. */
export function planArtifactMutation(profile: ProfilePack, mutation: ArtifactPlannedMutation): ArtifactPlanResult {
  const def = profile.artifacts?.[mutation.artifactType];
  if (!def) {
    const checks = [checkFromProblems("artifact-type-declared",
      [`artifact type ${JSON.stringify(mutation.artifactType)} is not declared by the active profile`])];
    return { decision: composeTrustDecision(checks, { reviewRouted: false }), checks };
  }
  const { body, problems } = bodyFor(def, mutation);
  const checks = [
    checkFromProblems("artifact-type-declared", []),
    checkFromProblems("artifact-members-shape", problems),
    checkFromProblems("artifact-body-contract", problems.length > 0 ? [] : validateArtifactBody(def, body)),
  ];
  return { decision: composeTrustDecision(checks, { reviewRouted: false }), checks, def, body };
}
