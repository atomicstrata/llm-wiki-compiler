/**
 * @file test/fixtures/artifact-seed.ts
 * @description Shared test helper that writes a HEALTHY artifact (body + manifest) into
 * a project's artifact store and returns its pinned ref, so artifact-precondition tests
 * don't each re-spell the hash/manifest/write/format sequence. Kept out of the pure-data
 * `artifact-precondition-profiles.ts` fixture because it touches `src/` store internals.
 */
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../../src/artifacts/store.js";
import { formatArtifactRef } from "../../src/artifacts/ref.js";
import { stageEntityPage } from "../../src/trust/staging.js";
import { researchArtifactPreconditionProfile } from "./artifact-precondition-profiles.js";

/** Write a healthy `artifactType` artifact for `slug` and return the ref that pins it. */
export async function seedArtifact(
  root: string,
  artifactType: string,
  fileName: string,
  slug: string,
  body: string,
  contentKind: ArtifactManifest["contentKind"],
): Promise<string> {
  const sha256 = hashArtifactBody(body);
  const manifest: ArtifactManifest = {
    artifactType, slug, sha256, bytes: Buffer.byteLength(body, "utf8"), contentKind, writtenAt: new Date().toISOString(),
  };
  await writeArtifactFiles(root, artifactPaths(root, artifactType, slug, fileName), body, manifest);
  return formatArtifactRef({ artifactType, slug, sha256 });
}

/**
 * Stage a `complete` experiment candidate pinning `ref` under the research-artifact
 * precondition profile and return its candidate id, so the artifact-precondition e2e
 * and the superset proof share one staging body (staging never enforces the
 * precondition — approval does).
 *
 * @param root - Project root with the research-artifact profile installed.
 * @param slug - The experiment slug to stage.
 * @param ref - The artifactRef the candidate pins in its `result` field.
 */
export async function stageCompleteExperimentCandidate(root: string, slug: string, ref: string): Promise<string> {
  const profile = researchArtifactPreconditionProfile();
  const body = `---\ntitle: Exp ${slug}\nstage: complete\nresult: "${ref}"\n---\n\nExperiment prose for the lint floor.\n`;
  const staged = await stageEntityPage(root, { entityType: "experiments", slug, body, profile, existingStagedCount: 0 });
  return staged.id;
}
