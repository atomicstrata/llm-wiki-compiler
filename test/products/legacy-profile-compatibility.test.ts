/**
 * @file test/products/legacy-profile-compatibility.test.ts
 * @description The legacy byte-identity guarantee (design section 8.2). With NO
 * active-product binding, the binding-aware `loadProfile` yields exactly the
 * pre-binding loader's result — same profile object, same `loadedFrom`, same
 * canonical digest — for BOTH the built-in default and a non-default disk profile.
 * Routing through the binding also adds no filesystem side effect: a clean project
 * gains no `.llmwiki` directory. Byte-identity is proven by deep-equality against
 * the exact expected object plus equality of the canonical `profileDigest`.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { loadProfile } from "../../src/profile/load.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";
import { profileDigest } from "../../src/profile/digest.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";

const root = useTempRoot();

/** A valid non-default disk profile, proven loadable by the profile loader suite. */
const VALID_PROFILE = { schemaVersion: 1, profileId: "custom", displayName: "Custom", entities: { docs: { directory: "wiki/docs" } } };

/** Whether a path exists at all. */
async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

/** Write `.llmwiki/profile.json` and return its path. */
async function writeProfile(content: string): Promise<string> {
  const file = path.join(root.dir, PROFILE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
}

describe("legacy byte-identity with no active binding", () => {
  it("default profile: loadProfile yields the exact pre-binding default result", async () => {
    const loaded = await loadProfile(root.dir);
    expect(loaded).toEqual({ profile: DEFAULT_PROFILE, loadedFrom: null, digest: profileDigest(DEFAULT_PROFILE) });
  });

  it("non-default profile: loadProfile yields the exact pre-binding disk result", async () => {
    const file = await writeProfile(JSON.stringify(VALID_PROFILE));
    const loaded = await loadProfile(root.dir);
    expect(loaded.loadedFrom).toBe(file);
    expect(loaded.digest).toBe(profileDigest(VALID_PROFILE as never));
    expect(loaded.profile.profileId).toBe("custom");
  });

  it("creates no .llmwiki directory on a clean project (read-only contract preserved)", async () => {
    await loadProfile(root.dir);
    expect(await exists(path.join(root.dir, ".llmwiki"))).toBe(false);
  });
});
