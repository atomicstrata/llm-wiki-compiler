/**
 * Exact-selector artifact discovery for recovery callers that lost a returned
 * reference. A manifest supplies only a candidate digest; the existing confined
 * verifier recomputes body hashes before discovery returns a reference. This is
 * not evidence that an operation happened, and unavailability never proves that
 * it did not. Callers must separately authenticate their occurrence bindings.
 */
import type { ArtifactRef } from "./ref.js";
import type { ProfilePack } from "../profile/types.js";
import { isSlugSafe } from "../profile/identity.js";
import { artifactPaths, readArtifactManifest } from "./store.js";
import { readVerifiedArtifactBody } from "./read-verified.js";

/** An exact location, not a glob or a query over project contents. */
export interface ArtifactSelectorV1 { artifactType: string; slug: string }
/** Unavailable deliberately does not distinguish absence from uncertain reads. */
export type ArtifactDiscoveryV1 = { status: "found"; ref: ArtifactRef } | { status: "unavailable" };

/** Capture own data properties before asynchronous profile loading; never call getters. */
export function captureArtifactSelector(input: ArtifactSelectorV1): ArtifactSelectorV1 {
  if (!input || typeof input !== "object") throw new TypeError("Invalid artifact selector");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 2) throw new TypeError("Invalid artifact selector");
  const artifactType = fields.artifactType?.value;
  const slug = fields.slug?.value;
  if (typeof artifactType !== "string" || typeof slug !== "string"
    || !isSlugSafe(artifactType) || !isSlugSafe(slug)) throw new TypeError("Invalid artifact selector");
  return { artifactType, slug };
}

/** Discover one declared artifact, returning only a freshly verified pinned reference. */
export async function discoverArtifact(
  root: string, profile: ProfilePack, selector: ArtifactSelectorV1,
): Promise<ArtifactDiscoveryV1> {
  const { artifactType, slug } = captureArtifactSelector(selector);
  const declared = profile.artifacts ?? {};
  const definition = Object.hasOwn(declared, artifactType) ? declared[artifactType] : undefined;
  if (!definition) return { status: "unavailable" };
  try {
    const manifest = await readArtifactManifest(root, artifactPaths(root, artifactType, slug, definition.fileName));
    if (manifest.kind !== "ok") return { status: "unavailable" };
    const ref = { artifactType, slug, sha256: manifest.manifest.sha256 };
    const verified = await readVerifiedArtifactBody(root, profile, ref);
    return verified.health === "ok" ? { status: "found", ref } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
}
