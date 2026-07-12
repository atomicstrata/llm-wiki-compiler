/**
 * @file src/profile/templates/artifact-audit.ts
 * @description Complete confined artifact-store audit for profile updates.
 * Every stored artifact is verified, including records not referenced by pages.
 */
import { resolveArtifactRef } from "../../artifacts/resolve.js";
import { artifactPaths, readArtifactManifest } from "../../artifacts/store.js";
import { isSlugSafe } from "../identity.js";
import type { ProfilePack } from "../types.js";
import { confinedEntries } from "./corpus.js";

const MAX_ARTIFACT_STORE_ENTRIES = 10_000;

/** Return compatibility blockers for every unexpected or unhealthy artifact. */
export async function auditArtifactStore(root: string, profile: ProfilePack): Promise<string[]> {
  const types = await entries(root, "artifacts");
  if (!Array.isArray(types)) return types === "absent" ? [] : ["artifact store is unreadable or unsafe"];
  const reasons: string[] = [];
  for (const artifactType of types) {
    const def = profile.artifacts?.[artifactType];
    if (!isSlugSafe(artifactType) || !def) {
      reasons.push(`artifact store contains undeclared type ${JSON.stringify(artifactType)}`);
      continue;
    }
    reasons.push(...await auditType(root, artifactType, def.fileName, profile));
  }
  return reasons;
}

async function auditType(
  root: string,
  artifactType: string,
  fileName: string,
  profile: ProfilePack,
): Promise<string[]> {
  const slugs = await entries(root, `artifacts/${artifactType}`);
  if (!Array.isArray(slugs)) return [`artifact type directory is unreadable or unsafe: ${artifactType}`];
  const reasons: string[] = [];
  for (const slug of slugs) {
    if (!isSlugSafe(slug)) reasons.push(`artifact store contains unsafe slug ${JSON.stringify(slug)}`);
    else reasons.push(...await auditArtifact(root, artifactType, slug, fileName, profile));
  }
  return reasons;
}

async function auditArtifact(
  root: string,
  artifactType: string,
  slug: string,
  fileName: string,
  profile: ProfilePack,
): Promise<string[]> {
  const relative = `artifacts/${artifactType}/${slug}`;
  const leaves = await entries(root, relative);
  if (!Array.isArray(leaves)) return [`artifact directory is unreadable or unsafe: ${relative}`];
  const expected = new Set([fileName, `${fileName}.manifest.json`]);
  if (leaves.some((leaf) => !expected.has(leaf))) return [`artifact directory contains unexpected files: ${relative}`];
  const paths = artifactPaths(root, artifactType, slug, fileName);
  const manifest = await readArtifactManifest(root, paths);
  if (manifest.kind !== "ok") return [`artifact manifest is ${manifest.kind}: ${artifactType}/${slug}`];
  const resolution = await resolveArtifactRef(root, profile, { artifactType, slug, sha256: manifest.manifest.sha256 });
  return resolution.health === "ok" ? [] : [`artifact is ${resolution.health}: ${artifactType}/${slug}`];
}

async function entries(root: string, relative: string): Promise<string[] | "absent" | "unavailable"> {
  const result = await confinedEntries(root, relative);
  if (Array.isArray(result) && result.length > MAX_ARTIFACT_STORE_ENTRIES) return "unavailable";
  return result;
}
