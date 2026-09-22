/**
 * @file src/local-workflow-host/artifact-manifest.ts
 * @description Resolve a declared artifact manifest under current profile
 * authority without accepting a caller-selected filesystem path.
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import { artifactPaths, readArtifactManifest } from "../artifacts/store.js";

/** Return null for an undeclared type; preserve absent/malformed/unavailable manifest outcomes. */
export async function readLocalWorkflowArtifactManifest(root: string, artifactType: string, slug: string) {
  const loaded = await loadNonDefaultProfile(root);
  const def = loaded?.profile.artifacts?.[artifactType];
  if (!def) return null;
  return readArtifactManifest(root, artifactPaths(root, artifactType, slug, def.fileName));
}
