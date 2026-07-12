/**
 * @file test/profile-template-status.test.ts
 * @description Verifies advisory provenance cannot bless template drift.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installBuiltinTemplate, installLocalTemplate } from "../src/profile/templates/install.js";
import { collectTemplateStatus } from "../src/profile/templates/status.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

describe("collectTemplateStatus", () => {
  it("reports untracked for the implicit default profile", async () => {
    const root = await makeTempRoot("template-status-default");
    expect(await collectTemplateStatus(root)).toMatchObject({ status: "untracked", profileId: "default" });
  });

  it("reports a clean independently-resolved builtin install", async () => {
    const root = await makeTempRoot("template-status-clean");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "1.0.0" });
    expect(await collectTemplateStatus(root)).toMatchObject({ status: "installed-clean", templateId: "newsroom" });
  });

  it("reports local modification even when the lock digest is forged to match", async () => {
    const root = await makeTempRoot("template-status-drift");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "1.0.0" });
    const profilePath = path.join(root, PROFILE_FILE);
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    await writeFile(profilePath, `${JSON.stringify({ ...profile, displayName: "Changed" }, null, 2)}\n`, "utf8");
    const status = await collectTemplateStatus(root);
    const lockPath = path.join(root, ".llmwiki/template-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    await writeFile(lockPath, JSON.stringify({ ...lock, profileDigest: status.activeProfileDigest }), "utf8");
    expect(await collectTemplateStatus(root)).toMatchObject({ status: "locally-modified" });
  });

  it("does not claim local package provenance is independently verified", async () => {
    const root = await makeTempRoot("template-status-local");
    const packageFile = path.join(root, "team.json");
    await writeFile(packageFile, JSON.stringify(localPackage()), "utf8");
    await installLocalTemplate(root, packageFile, { force: false, currentVersion: "1.0.0" });
    expect(await collectTemplateStatus(root)).toMatchObject({ status: "source-release-unavailable" });
  });
});

function localPackage(): Record<string, unknown> {
  return {
    schemaVersion: 1, templateId: "team", version: "1.0.0", displayName: "Team",
    publisher: "example", sourceType: "local", license: "MIT", minLlmwikiVersion: "1.0.0",
    profile: {
      schemaVersion: 1, profileId: "team", displayName: "Team",
      entities: { items: { directory: "wiki/items", titleField: "title", fields: { title: { type: "string", required: true } } } },
    },
  };
}
