/**
 * @file src/artifacts/capture-member.ts
 * @description Generic one-member artifact capture through the existing locked,
 * journaled write authority, followed by the existing full health resolver.
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import { applyApprovedMutations } from "../trust/executor.js";
import type { ArtifactOrigin } from "../trust/planner.js";
import type { ArtifactMemberFileInput } from "./members.js";
import type { ArtifactRef } from "./ref.js";
import { resolveArtifactRef } from "./resolve.js";

export interface CaptureMemberArtifactV1 {
  readonly artifactType: string;
  readonly slug: string;
  readonly member: ArtifactMemberFileInput;
  readonly origin: ArtifactOrigin;
}

/** Persist one member atomically and return only after the complete ref verifies. */
export async function captureVerifiedMemberArtifact(
  root: string, input: CaptureMemberArtifactV1,
): Promise<ArtifactRef> {
  const [applied] = await applyApprovedMutations(root, [{
    kind: "artifact", artifactType: input.artifactType, slug: input.slug,
    body: "", memberFiles: [input.member], origin: input.origin,
  }]);
  if (applied?.kind !== "artifact") throw new Error("member capture returned a non-artifact result");
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new Error("member capture requires an active non-default profile");
  const resolved = await resolveArtifactRef(root, loaded.profile, applied.ref);
  if (resolved.health !== "ok") throw new Error(`captured member artifact is not healthy: ${resolved.health}`);
  return applied.ref;
}
