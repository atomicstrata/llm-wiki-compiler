/**
 * @file test/profile-template-genericity.test.ts
 * @description Regression tests for the template loader boundary and domain-data isolation.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import { profileDigest } from "../src/profile/digest.js";
import { loadProfile } from "../src/profile/load.js";
import { installBuiltinTemplate } from "../src/profile/templates/install.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const TEMPLATE_DATA_FILES = [
  `builtin${path.sep}default.ts`,
  `builtin${path.sep}autosci${path.sep}entities.ts`,
  `builtin${path.sep}autosci${path.sep}relations.ts`,
  `builtin${path.sep}autosci${path.sep}artifacts.ts`,
  `builtin${path.sep}autosci${path.sep}workflows.ts`,
  `builtin${path.sep}autosci.ts`,
  `builtin${path.sep}newsroom.ts`,
];

async function tsFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  return names.filter((name) => name.endsWith(".ts"));
}

async function srcTsFiles(): Promise<string[]> {
  return (await tsFiles(path.resolve("src"))).map((name) => name.split(path.sep).join("/"));
}

describe("profile template genericity", () => {
  it("keeps loadProfile independent of template modules", async () => {
    const text = await readFile(path.resolve("src/profile/load.ts"), "utf8");
    expect(text).not.toMatch(/\bfrom\s+["'][^"']*templates\//);
    expect(text).not.toMatch(/\bimport\s*\(\s*["'][^"']*templates\//);
    const root = await makeTempRoot("template-loader-boundary");

    const loaded = await loadProfile(root);

    expect(loaded.profile).toBe(DEFAULT_PROFILE);
  });

  it("loads installed templates through .llmwiki/profile.json rather than the registry", async () => {
    const root = await makeTempRoot("template-loader-installed");
    await installBuiltinTemplate(root, "newsroom", { force: false, currentVersion: "1.0.0" });
    const profilePath = path.join(root, ".llmwiki/profile.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    const diskOnlyProfile = { ...profile, displayName: "Disk Newsroom", profileVersion: "disk-only" };
    await writeFile(profilePath, `${JSON.stringify(diskOnlyProfile, null, 2)}\n`, "utf8");

    const loaded = await loadProfile(root);

    expect(loaded.loadedFrom).toBe(profilePath);
    expect(loaded.profile.profileId).toBe("newsroom");
    expect(loaded.profile.displayName).toBe("Disk Newsroom");
    expect(loaded.digest).toBe(profileDigest(loaded.profile));
  });

  it("confines exact template identity branches to builtin template data", async () => {
    const files = await tsFiles(path.resolve("src/profile/templates"));
    const builtinFiles = files.filter((name) => name.startsWith(`builtin${path.sep}`)).sort();
    expect(builtinFiles).toEqual([...TEMPLATE_DATA_FILES].sort());
    const offenders: string[] = [];

    for (const file of await srcTsFiles()) {
      const templateRel = file.replace(/^profile\/templates\//, "").split("/").join(path.sep);
      if (TEMPLATE_DATA_FILES.includes(templateRel)) continue;
      const text = await readFile(path.join("src", file), "utf8");
      if (/(profileId|templateId)\s*={2,3}\s*["'](research|newsroom|autosci)["']/.test(text)) offenders.push(file);
      if (/\b(isResearch|isNewsroom)\b/.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("keeps builtin template data imported only by the install-time registry", async () => {
    const allowed = new Set(["profile/templates/registry.ts"]);
    const offenders: string[] = [];

    for (const file of await srcTsFiles()) {
      if (file.startsWith("profile/templates/builtin/")) continue;
      const text = await readFile(path.join("src", file), "utf8");
      if (/from\s+["'][^"']*profile\/templates\/builtin\//.test(text) && !allowed.has(file)) offenders.push(file);
      if (/from\s+["']\.\/builtin\//.test(text) && !allowed.has(file)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
