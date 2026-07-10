/**
 * @file test/profile-template-local.test.ts
 * @description Tests for local profile template package installation.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/profile/load.js";
import { installLocalTemplate } from "../src/profile/templates/install.js";
import { MAX_PROFILE_BYTES } from "../src/utils/constants.js";
import { listProjectFiles } from "./fixtures/project-files.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const LOCK_FILE = ".llmwiki/template-lock.json";

async function writePackage(root: string, body: unknown): Promise<string> {
  const file = path.join(root, "team-template.json");
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

function localPackage(sourceType: "builtin" | "local" = "local") {
  return {
    schemaVersion: 1,
    templateId: "team",
    version: "0.1.0",
    displayName: "Team",
    publisher: "team",
    sourceType,
    license: "MIT",
    minLlmwikiVersion: "0.1.0",
    profile: {
      schemaVersion: 1,
      profileId: "team",
      displayName: "Team",
      entities: { docs: { directory: "wiki/docs" } },
    },
  };
}

async function expectNoProfile(root: string): Promise<void> {
  await expect(readFile(path.join(root, ".llmwiki/profile.json"), "utf8")).rejects.toThrow();
  await expect(readFile(path.join(root, LOCK_FILE), "utf8")).rejects.toThrow();
}

async function expectLocalRefusalLeavesNoProfile(root: string, pkg: unknown, pattern: RegExp): Promise<void> {
  const file = await writePackage(root, pkg);
  await expect(installLocalTemplate(root, file, { force: false, currentVersion: "0.11.0" }))
    .rejects.toThrow(pattern);
  expect(await listProjectFiles(root)).toEqual([path.basename(file)]);
}

describe("installLocalTemplate", () => {
  it("installs a valid local package and records sourceType local in the lock", async () => {
    const root = await makeTempRoot("template-local");
    const file = await writePackage(root, localPackage());

    const result = await installLocalTemplate(root, file, { force: false, currentVersion: "0.11.0" });

    expect(result).toMatchObject({ templateId: "team", version: "0.1.0", lockWritten: true });
    expect((await loadProfile(root)).profile.profileId).toBe("team");
    const lock = JSON.parse(await readFile(path.join(root, LOCK_FILE), "utf8")) as Record<string, unknown>;
    expect(lock.sourceType).toBe("local");
    expect(await listProjectFiles(root)).toEqual([
      ".llmwiki/profile.json",
      ".llmwiki/template-lock.json",
      "team-template.json",
    ]);
  });

  it("fails before writes when a local package self-attests as builtin", async () => {
    const root = await makeTempRoot("template-local-source-mismatch");
    const file = await writePackage(root, localPackage("builtin"));

    await expect(installLocalTemplate(root, file, { force: false, currentVersion: "0.11.0" }))
      .rejects.toThrow(/sourceType/i);
    await expectNoProfile(root);
  });

  it("fails before writes on invalid JSON", async () => {
    const root = await makeTempRoot("template-local-invalid-json");
    const file = path.join(root, "bad.json");
    await writeFile(file, "{broken", "utf8");

    await expect(installLocalTemplate(root, file, { force: false, currentVersion: "0.11.0" }))
      .rejects.toThrow(/invalid template JSON/i);
    await expectNoProfile(root);
  });

  it("fails before writes on an oversized local package file", async () => {
    const root = await makeTempRoot("template-local-oversize");
    const file = path.join(root, "oversize.json");
    await writeFile(file, `{ "pad": "${"x".repeat(MAX_PROFILE_BYTES * 2)}" }`, "utf8");

    await expect(installLocalTemplate(root, file, { force: false, currentVersion: "0.11.0" }))
      .rejects.toThrow(/invalid template JSON/i);
    await expectNoProfile(root);
  });

  it("fails before writes on a symlinked local package file", async () => {
    const root = await makeTempRoot("template-local-symlink");
    const target = await writePackage(root, localPackage());
    const link = path.join(root, "linked-template.json");
    await symlink(target, link);

    await expect(installLocalTemplate(root, link, { force: false, currentVersion: "0.11.0" }))
      .rejects.toThrow(/invalid template JSON/i);
    await expectNoProfile(root);
  });

  it("fails before writes when the installed profile would exceed the profile cap", async () => {
    const root = await makeTempRoot("template-local-profile-cap");
    const pkg = localPackage();
    pkg.profile.entities.docs.fields = {
      title: { type: "string", required: true },
      pad: { type: "enum", enum: ["x".repeat(MAX_PROFILE_BYTES + 1)] },
    };
    await expectLocalRefusalLeavesNoProfile(root, pkg, /profile cap/i);
  });

  it("fails before writes when templateId and profileId differ", async () => {
    const root = await makeTempRoot("template-local-id-mismatch");
    const pkg = localPackage();
    pkg.profile.profileId = "other";
    await expectLocalRefusalLeavesNoProfile(root, pkg, /templateId must match profileId/i);
  });

  it("fails before writes on a reserved default profile id", async () => {
    const root = await makeTempRoot("template-local-reserved-default");
    const pkg = localPackage();
    pkg.templateId = "default";
    pkg.profile.profileId = "default";
    await expectLocalRefusalLeavesNoProfile(root, pkg, /default/i);
  });

  it("refuses a local template whose connector binding is not registered", async () => {
    const root = await makeTempRoot("template-local-bad-connector");
    const pkg = localPackage();
    pkg.profile.connectors = {
      missing: { entityType: "docs", fields: { title: "title" } },
    };
    await expectLocalRefusalLeavesNoProfile(root, pkg, /not registered/);
  });

  it("refuses a local template whose connector binding names the test fixture connector", async () => {
    const root = await makeTempRoot("template-local-fixture-connector");
    const pkg = localPackage();
    pkg.profile.entities.docs.fields = { title: { type: "string" } };
    pkg.profile.connectors = {
      fixture: { entityType: "docs", fields: { headline: "title" } },
    };
    await expectLocalRefusalLeavesNoProfile(root, pkg, /not installable in templates/);
  });
});
