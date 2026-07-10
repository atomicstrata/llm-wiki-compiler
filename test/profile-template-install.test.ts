/**
 * @file test/profile-template-install.test.ts
 * @description Tests for builtin profile template installation.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileDigest } from "../src/profile/digest.js";
import { loadProfile, ProfileLoadError } from "../src/profile/load.js";
import { installBuiltinTemplate } from "../src/profile/templates/install.js";
import { CANDIDATES_ARCHIVE_DIR, PROFILE_FILE, RELATIONS_FILE } from "../src/utils/constants.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { listProjectFiles } from "./fixtures/project-files.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const LOCK_FILE = ".llmwiki/template-lock.json";

async function readJson(root: string, rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, rel), "utf8")) as Record<string, unknown>;
}

async function expectProjectLockReleased(root: string): Promise<void> {
  const acquired = await acquireLock(root, { quiet: true });
  expect(acquired).toBe(true);
  if (acquired) await releaseLock(root);
}

describe("installBuiltinTemplate", () => {
  it("installs autosci profile and advisory lock into an empty project", async () => {
    const root = await makeTempRoot("template-install-autosci");

    const result = await installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" });

    expect(result).toMatchObject({ kind: "installed", templateId: "autosci", version: "0.1.0", lockWritten: true });
    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("autosci");
    expect(await readJson(root, LOCK_FILE)).toMatchObject({
      schemaVersion: 1,
      templateId: "autosci",
      version: "0.1.0",
      publisher: "atomicstrata",
      sourceType: "builtin",
      profileDigest: profileDigest(loaded.profile),
    });
    await expectProjectLockReleased(root);
  });

  it("template init writes only profile and advisory lock", async () => {
    const root = await makeTempRoot("template-install-write-discipline");

    await installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" });

    expect(await listProjectFiles(root)).toEqual([
      ".llmwiki/profile.json",
      ".llmwiki/template-lock.json",
    ]);
  });

  it("installs newsroom without a connector binding", async () => {
    const root = await makeTempRoot("template-install-newsroom");

    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "0.12.0" });

    const loaded = await loadProfile(root);
    expect(loaded.profile.profileId).toBe("newsroom");
    expect(loaded.profile.connectors).toBeUndefined();
  });

  it("refuses default because default is already active without a profile file", async () => {
    const root = await makeTempRoot("template-install-default");

    await expect(installBuiltinTemplate(root, "default", { force: false, currentVersion: "0.12.0" }))
      .rejects.toThrow(/default profile is already active/i);
    await expect(readFile(path.join(root, PROFILE_FILE), "utf8")).rejects.toThrow();
  });

  it("refuses to install over a populated default wiki", async () => {
    const root = await makeTempRoot("template-install-default-populated");
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/rag.md"), "# RAG\n", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: true, currentVersion: "0.12.0" }))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("refuses to overwrite an existing profile without force", async () => {
    const root = await makeTempRoot("template-install-existing");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "0.12.0" });

    await expect(installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" }))
      .rejects.toThrow(/profile already exists/i);
    await expectProjectLockReleased(root);
  });

  it("allows force overwrite only when typed corpus is empty", async () => {
    const root = await makeTempRoot("template-install-force-empty");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "0.12.0" });

    await installBuiltinTemplate(root, "autosci", { force: true, currentVersion: "0.12.0" });

    expect((await loadProfile(root)).profile.profileId).toBe("autosci");
  });

  it("still succeeds when the advisory lock cannot be written after the profile is installed", async () => {
    const root = await makeTempRoot("template-install-lock-best-effort");
    await mkdir(path.join(root, LOCK_FILE), { recursive: true });

    const result = await installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" });

    expect(result).toMatchObject({ templateId: "autosci", version: "0.1.0", lockWritten: false });
    expect((await loadProfile(root)).profile.profileId).toBe("autosci");
    await expectProjectLockReleased(root);
  });

  it("refuses force overwrite when typed pages exist", async () => {
    const root = await makeTempRoot("template-install-force-nonempty");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "0.12.0" });
    await mkdir(path.join(root, "wiki/articles"), { recursive: true });
    await writeFile(path.join(root, "wiki/articles/story.md"), "---\nheadline: Story\nstage: draft\n---\n\nBody", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: true, currentVersion: "0.12.0" }))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("refuses a no-profile project that already has typed stores", async () => {
    const root = await makeTempRoot("template-install-default-nonempty");
    await mkdir(path.join(root, ".llmwiki/workflows/runs"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki/workflows/runs/run-1.json"), "{}", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" }))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("refuses when archived review candidates exist", async () => {
    const root = await makeTempRoot("template-install-archived-candidate");
    await mkdir(path.join(root, CANDIDATES_ARCHIVE_DIR), { recursive: true });
    await writeFile(path.join(root, CANDIDATES_ARCHIVE_DIR, "old.json"), "{}", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: false, currentVersion: "0.12.0" }))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("refuses when the relation store has unresolved problems", async () => {
    const root = await makeTempRoot("template-install-relation-problem");
    await mkdir(path.dirname(path.join(root, RELATIONS_FILE)), { recursive: true });
    await writeFile(path.join(root, RELATIONS_FILE), "{\"kind\":\"relation-store-header\",\"schemaVersion\":1}\n{\"id\"", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: true, currentVersion: "0.12.0" }))
      .rejects.toThrow(/typed corpus is not empty/i);
  });

  it("refuses a present but unloadable profile even with force", async () => {
    const root = await makeTempRoot("template-install-broken-active");
    const profileDir = path.join(root, path.dirname(PROFILE_FILE));
    await mkdir(profileDir, { recursive: true });
    const profilePath = path.join(root, PROFILE_FILE);
    await writeFile(profilePath, "{broken", "utf8");

    await expect(installBuiltinTemplate(root, "autosci", { force: true, currentVersion: "0.12.0" }))
      .rejects.toBeInstanceOf(ProfileLoadError);
    await expectProjectLockReleased(root);
  });
});
