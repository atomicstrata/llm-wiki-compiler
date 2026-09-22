/**
 * Real profile collection fixtures for declaration-aware confidence checks.
 * Each invocation writes one isolated note and profile, preserving YAML scalar
 * types (including non-finite numbers) and the collector's schema problems.
 * Temporary roots are removed after each test, including failed assertions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump } from "js-yaml";
import { collectEntityPages, type EntityCollectResult } from "../../src/profile/collect.js";
import type { EntityPage, EntityTypeDef, ProfilePack } from "../../src/profile/types.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { useScratchDirs } from "../capability-providers/scratch-dirs.js";

const scratch = useScratchDirs();

/** Collect a note against a real profile, retaining schema findings for invalid values. */
export async function collectConfidenceFixture(
  value: unknown,
  definition: EntityTypeDef = { directory: "wiki/notes", fields: { confidence: { type: "number" } } },
): Promise<EntityCollectResult & { definition: EntityTypeDef }> {
  const root = await scratch("profile-confidence-");
  const profile: ProfilePack = {
    schemaVersion: 1,
    profileId: "confidence-test",
    entities: { notes: definition },
  };
  await mkdir(path.join(root, definition.directory), { recursive: true });
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile));
  const fields = value === undefined ? { title: "Note" } : { title: "Note", confidence: value };
  await writeFile(path.join(root, definition.directory, "note.md"), `---\n${dump(fields)}---\n# Note\n`);
  return { ...(await collectEntityPages(root, profile)), definition };
}

/** Return a collector-produced page for the standard declared numeric profile. */
export async function confidenceFixture(value: unknown): Promise<{ page: EntityPage; definition: EntityTypeDef }> {
  const { pages, problems, definition } = await collectConfidenceFixture(value);
  if (pages.length !== 1 || problems.length !== 0) {
    throw new Error(`Expected one valid confidence page: ${JSON.stringify(problems)}`);
  }
  return { page: pages[0], definition };
}
