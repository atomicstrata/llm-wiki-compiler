/**
 * Tests for the fail-closed profile loader.
 *
 * Verifies the load contract: a MISSING profile file falls back to the
 * built-in default (with `loadedFrom: null` and a stable digest); a valid file
 * loads with its source path set; an unsupported schemaVersion or malformed
 * JSON is a hard error (the default is NEVER substituted for a present-but-
 * broken file); and reformatting a valid profile (whitespace + key reorder)
 * yields an identical digest.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { loadProfile, ProfileLoadError } from "../src/profile/load.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import { profileDigest } from "../src/profile/digest.js";
import { PROFILE_FILE } from "../src/utils/constants.js";

/** Write a `.llmwiki/profile.json` containing `content` under `root`. */
async function writeProfile(root: string, content: string): Promise<string> {
  const filePath = path.join(root, PROFILE_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** A valid custom profile object, serialized differently per call. */
const VALID_PROFILE = {
  schemaVersion: 1,
  profileId: "custom",
  displayName: "Custom",
  entities: { docs: { directory: "wiki/docs" } },
};

describe("loadProfile", () => {
  it("falls back to the default profile when no file is present", async () => {
    const root = await makeTempRoot("profile-missing");
    const loaded = await loadProfile(root);
    expect(loaded.profile).toBe(DEFAULT_PROFILE);
    expect(loaded.loadedFrom).toBeNull();
    expect(loaded.digest).toBe(profileDigest(DEFAULT_PROFILE));
  });

  it("loads a valid profile file with loadedFrom set", async () => {
    const root = await makeTempRoot("profile-valid");
    const filePath = await writeProfile(root, JSON.stringify(VALID_PROFILE));
    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("custom");
    expect(loaded.loadedFrom).toBe(filePath);
    expect(loaded.digest).toBe(profileDigest(VALID_PROFILE as never));
  });

  it("throws fail-closed on an unsupported schemaVersion", async () => {
    const root = await makeTempRoot("profile-v2");
    await writeProfile(root, JSON.stringify({ ...VALID_PROFILE, schemaVersion: 2 }));
    await expect(loadProfile(root)).rejects.toThrow();
  });

  it("throws ProfileLoadError on malformed JSON, never the default", async () => {
    const root = await makeTempRoot("profile-broken");
    await writeProfile(root, "{ not valid json ");
    await expect(loadProfile(root)).rejects.toBeInstanceOf(ProfileLoadError);
  });

  it("yields an identical digest after whitespace + key reordering", async () => {
    const root = await makeTempRoot("profile-reformat");
    await writeProfile(root, JSON.stringify(VALID_PROFILE));
    const first = await loadProfile(root);
    const reformatted = JSON.stringify(
      { entities: VALID_PROFILE.entities, displayName: "Custom", profileId: "custom", schemaVersion: 1 },
      null,
      2,
    );
    await writeProfile(root, reformatted);
    const second = await loadProfile(root);
    expect(second.digest).toBe(first.digest);
  });
});
