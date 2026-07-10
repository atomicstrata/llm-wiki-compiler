/**
 * Hash-pinned artifact reference: the compact on-disk value a page/relation field
 * carries to point at a specific artifact CONTENT (not a mutable target). Structural
 * only — parsing validates shape/slug/hex, never touches disk. Declared-type + scope
 * checks are the profile-aware Layer B (src/profile/artifact-ref-validate.ts).
 */
import { isSlugSafe } from "../profile/identity.js";

/** A parsed hash-pinned reference. */
export interface ArtifactRef {
  artifactType: string;
  slug: string;
  sha256: string;
}

const REF_PATTERN = /^([^/@]+)\/([^/@]+)@sha256:([0-9a-f]{64})$/;

/** Parse the compact form, or null when the value is not a structurally valid ref. */
export function parseArtifactRef(value: unknown): ArtifactRef | null {
  if (typeof value !== "string") return null;
  const m = REF_PATTERN.exec(value);
  if (!m) return null;
  const [, artifactType, slug, sha256] = m;
  if (!isSlugSafe(artifactType) || !isSlugSafe(slug)) return null;
  return { artifactType, slug, sha256 };
}

/** Render a ref back to its canonical compact form. */
export function formatArtifactRef(ref: ArtifactRef): string {
  return `${ref.artifactType}/${ref.slug}@sha256:${ref.sha256}`;
}
