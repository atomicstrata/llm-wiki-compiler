/**
 * @file test/profile-template-cli.test.ts
 * @description Exercises the compiled template CLI against real project roots
 * so list, inspect, and init behavior stays wired through Commander and the
 * installed dist/cli.js entrypoint instead of only unit-level handlers.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOSCI_TEMPLATE } from "../src/profile/templates/builtin/autosci.js";

const CLI = path.resolve("dist/cli.js");

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-cli-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("template CLI", () => {
  it("lists default, autosci, and newsroom", async () => {
    await withRoot(async (root) => {
      const result = run(root, ["template", "list"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("default");
      expect(result.stdout).toContain("autosci");
      expect(result.stdout).toContain("connectors:crossref");
      expect(result.stdout).toContain("newsroom");
      expect(result.stdout).not.toContain("connectors:fixture");
    });
  });

  it("inspects a builtin template", async () => {
    await withRoot(async (root) => {
      const result = run(root, ["template", "inspect", "autosci"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("templateId: autosci");
      expect(result.stdout).toContain("profileId:  autosci");
      expect(result.stdout).toContain("license:    MIT");
      expect(result.stdout).toContain("minVersion: 1.0.0");
      expect(result.stdout).toContain("connectors: crossref");
      expect(result.stdout).toContain("workflowActions:");
      expect(result.stdout).toContain("contentTiers:");
      expect(result.stdout).toContain("relationPreconditions:");
      expect(result.stdout).toContain("artifactPreconditions:");
      expect(result.stdout).toMatch(/digest:\s+[a-f0-9]{64}/);
      expect(result.stdout).toContain("install:    llmwiki template init autosci");
    });
  });

  it("inspects default as non-installable", async () => {
    await withRoot(async (root) => {
      const result = run(root, ["template", "inspect", "default"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("templateId: default");
      expect(result.stdout).toContain("profileId:  default");
      expect(result.stdout).toContain("install:    not installable");
    });
  });

  it("refuses default init without writing", async () => {
    await withRoot(async (root) => {
      const result = run(root, ["template", "init", "default"]);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("default profile is already active");
      await expect(readFile(path.join(root, ".llmwiki/profile.json"), "utf8")).rejects.toThrow();
    });
  });

  it("installs autosci through the real CLI", async () => {
    await withRoot(async (root) => {
      const result = run(root, ["template", "init", "autosci"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installed template 'autosci' 0.1.0");
      const profilePath = path.join(root, ".llmwiki/profile.json");
      const lockPath = path.join(root, ".llmwiki/template-lock.json");
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      expect(profile.profileId).toBe("autosci");
      expect(lock.templateId).toBe("autosci");
    });
  });

  it("prints the installed local template version", async () => {
    await withRoot(async (root) => {
      const autosciTemplate = structuredClone(AUTOSCI_TEMPLATE);
      const template = {
        ...autosciTemplate,
        templateId: "team",
        sourceType: "local",
        version: "0.2.0",
        profile: { ...autosciTemplate.profile, profileId: "team" },
      };
      const templatePath = path.join(root, "team-template.json");
      await writeFile(templatePath, JSON.stringify(template), "utf8");

      const result = run(root, ["template", "init", "--file", templatePath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Installed template 'team' 0.2.0");
    });
  });

  it("requires exactly one init source", async () => {
    await withRoot(async (root) => {
      expect(run(root, ["template", "init"]).status).toBe(1);
      expect(run(root, ["template", "init", "autosci", "--file", "x.json"]).status).toBe(1);
    });
  });

  it("reports verified builtin status and previews an update without writes", async () => {
    await withRoot(async (root) => {
      expect(run(root, ["template", "init", "autosci"]).status).toBe(0);
      const before = await readFile(path.join(root, ".llmwiki/profile.json"), "utf8");
      const status = run(root, ["template", "status", "--json"]);
      const update = run(root, ["template", "update", "--dry-run", "--json"]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ status: "installed-clean", templateId: "autosci" });
      expect(update.status).toBe(0);
      expect(JSON.parse(update.stdout)).toMatchObject({ authority: "advisory", compatible: true, reasons: [] });
      expect(await readFile(path.join(root, ".llmwiki/profile.json"), "utf8")).toBe(before);
    });
  });

  it("refuses an update command that omits the dry-run gate", async () => {
    await withRoot(async (root) => {
      expect(run(root, ["template", "init", "autosci"]).status).toBe(0);
      const result = run(root, ["template", "update"]);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("pass --dry-run");
    });
  });
});
