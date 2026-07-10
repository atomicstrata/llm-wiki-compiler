/**
 * Test fixture: a temp project root with a research-like profile declaring the
 * `experiment-result` artifact type, for the artifact write/apply test suites.
 * Mirrors the shape `test/artifacts/profile-artifacts.test.ts` validates: a
 * well-formed json artifact with a required numeric `accuracy` metadata field.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./temp-root.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { applyApprovedMutations } from "../../src/trust/executor.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";

/** The profile pack under test: one `note` entity + the `experiment-result` artifact type. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "artifact-fixture",
  entities: {
    note: { directory: "wiki/notes" },
  },
  artifacts: {
    "experiment-result": {
      fileName: "result.json",
      contentKind: "json",
      maxBytes: 65536,
      metadata: { accuracy: { type: "number", required: true } },
    },
  },
};

/**
 * Create a fresh temp project root with `.llmwiki/profile.json` declaring the
 * `experiment-result` artifact type (see {@link PROFILE}).
 *
 * @param prefix - Short label folded into the temp directory name.
 * @returns Absolute path to the materialized project root.
 */
export async function makeResearchLikeRoot(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(PROFILE, null, 2)}\n`, "utf8");
  return root;
}

/**
 * Create a fresh temp project root with a NON-DEFAULT profile (one `note`
 * entity) that declares NO `artifacts` block at all — distinct from a bare
 * root with no profile file. Exercises the "active profile, zero declared
 * artifact types" case, as opposed to "no active profile".
 *
 * @param prefix - Short label folded into the temp directory name.
 * @returns Absolute path to the materialized project root.
 */
export async function makeNonDefaultRootWithNoArtifactTypes(prefix: string): Promise<string> {
  const root = await makeTempRoot(prefix);
  const profile: ProfilePack = { schemaVersion: 1, profileId: "no-artifacts-fixture", entities: { note: { directory: "wiki/notes" } } };
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return root;
}

/**
 * Write an artifact through the self-locking `applyApprovedMutations` entry
 * (never `applyArtifactLocked` directly — it requires the held lock), granting
 * the out-of-band `LLMWIKI_TRUSTED_WRITE` operator override for the duration of
 * the call only. Shared by the resolve/health-surface suites so they don't each
 * re-spell the grant/write/result-check sequence.
 *
 * @param root - Absolute project root whose profile declares `artifactType`.
 * @param artifactType - The profile-declared artifact type to write.
 * @param slug - The artifact's slug.
 * @param body - The raw artifact body bytes.
 * @returns The persisted {@link ArtifactRef}.
 */
export async function seedArtifact(root: string, artifactType: string, slug: string, body: string): Promise<ArtifactRef> {
  process.env.LLMWIKI_TRUSTED_WRITE = "*";
  try {
    const [result] = await applyApprovedMutations(root, [{ kind: "artifact", artifactType, slug, body, origin: "cli" }]);
    if (result.kind !== "artifact") throw new Error("expected artifact result");
    return result.ref;
  } finally {
    delete process.env.LLMWIKI_TRUSTED_WRITE;
  }
}
