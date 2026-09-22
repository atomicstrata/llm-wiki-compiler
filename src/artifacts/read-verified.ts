/**
 * SDK-compatible verified artifact body access. Reuses the public compiler's
 * single-read verifier rather than re-opening a file after verification. Only
 * the exact, digest-checked snapshot is returned; unhealthy reads expose no bytes.
 */
import { readVerifiedArtifact, type ArtifactHealth } from "./resolve.js";
import type { ArtifactRef } from "./ref.js";
import type { ProfilePack } from "../profile/types.js";

/** An artifact health verdict with bytes only on a healthy verified read. */
export interface VerifiedArtifactBodyV1 {
  readonly health: ArtifactHealth;
  readonly bytes?: Buffer;
}

/** Return the verified snapshot in the byte-oriented SDK contract. */
export async function readVerifiedArtifactBody(
  root: string, profile: ProfilePack, ref: ArtifactRef,
): Promise<VerifiedArtifactBodyV1> {
  const result = await readVerifiedArtifact(root, profile, ref);
  if (result.health !== "ok" || result.body === undefined) return { health: result.health };
  return { health: "ok", bytes: Buffer.from(result.body, "utf8") };
}
