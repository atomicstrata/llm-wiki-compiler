/**
 * @file test/fixtures/escape-runs-store.ts
 * @description Shared helper for the runs-store-availability suites.
 *
 * Both the unscoped `workflow status` and the action-scoped `build.status`
 * availability tests need the SAME symlink escape: install a profile, then point
 * `.llmwiki/workflows` at an out-of-tree dir so the runs store realpaths outside
 * the private dir and reads `unavailable` (not a clean empty) while the profile
 * stays readable. Extracting it removes the duplicated boilerplate fallow flags.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../src/utils/constants.js";
import type { ProfilePack } from "../../src/profile/types.js";

/**
 * Install `profile`, then escape `.llmwiki/workflows` to `<outside>` so the runs
 * store is unenumerable while the profile stays readable. The out-of-tree `runs`
 * dir must exist (else the store reads `absent`, not `unavailable`).
 *
 * @param root - In-project root to install the profile + symlink under.
 * @param outside - Out-of-tree dir the `workflows` symlink targets.
 * @param profile - The profile to install as the active on-disk profile.
 * @returns `true` on success, `false` when the platform cannot create symlinks.
 */
export async function escapeRunsStore(root: string, outside: string, profile: ProfilePack): Promise<boolean> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile), "utf8");
  await mkdir(path.join(outside, "runs"), { recursive: true });
  try {
    await symlink(outside, path.join(root, LLMWIKI_DIR, "workflows"), "dir");
    return true;
  } catch {
    return false;
  }
}
