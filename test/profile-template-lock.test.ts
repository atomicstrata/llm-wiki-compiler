/**
 * @file test/profile-template-lock.test.ts
 * @description Verifies template lock files are advisory and never grant authority.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileValidate } from "../src/commands/profile.js";
import { loadProfile } from "../src/profile/load.js";
import { installBuiltinTemplate } from "../src/profile/templates/install.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const LOCK_FILE = ".llmwiki/template-lock.json";

describe("template lock anti-authority", () => {
  it("does not affect loadProfile when sourceType or digest is forged", async () => {
    const root = await makeTempRoot("template-lock-forged");
    await installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "1.0.0" });
    const before = await loadProfile(root);
    const lockPath = path.join(root, LOCK_FILE);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;

    await writeFile(lockPath, JSON.stringify({ ...lock, sourceType: "builtin", profileDigest: "0".repeat(64) }), "utf8");

    const after = await loadProfile(root);
    expect(after.digest).toBe(before.digest);
    expect(after.profile.profileId).toBe("autosci");
  });

  it("does not block loading a valid profile when the lock is missing or corrupt", async () => {
    const root = await makeTempRoot("template-lock-missing");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "1.0.0" });

    await rm(path.join(root, LOCK_FILE));
    await expect(loadProfile(root)).resolves.toMatchObject({ profile: { profileId: "newsroom" } });
    await writeFile(path.join(root, LOCK_FILE), "{broken", "utf8");
    await expect(loadProfile(root)).resolves.toMatchObject({ profile: { profileId: "newsroom" } });
  });

  it("profile validate ignores lock contents", async () => {
    const root = await makeTempRoot("template-lock-profile-validate");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "1.0.0" });
    await writeFile(path.join(root, LOCK_FILE), "{broken", "utf8");
    const oldCwd = process.cwd();
    try {
      process.chdir(root);
      await expect(profileValidate()).resolves.toBe(0);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
