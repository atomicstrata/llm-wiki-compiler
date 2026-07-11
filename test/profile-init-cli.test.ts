/**
 * @file test/profile-init-cli.test.ts
 * @description Built-CLI coverage for beginner profile scaffolding.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectProfileAbsent, managedTempRoots } from "./fixtures/managed-temp-roots.js";
import { runCLI } from "./fixtures/run-cli.js";

const roots = managedTempRoots();

async function expectFailedInstall(
  result: Awaited<ReturnType<typeof runCLI>>,
  root: string,
  errorPattern: RegExp,
): Promise<void> {
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(errorPattern);
  expect(result.stderr).toMatch(/no profile was installed/i);
  await expectProfileAbsent(root);
}

afterEach(roots.cleanup);

describe("profile init CLI", () => {
  it("creates a profile and prints stable next steps", async () => {
    const root = await roots.create("profile-init-cli");

    const result = await runCLI(["profile", "init", "issue-tracker", "--entity", "issues"], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Created profile 'issue-tracker'");
    expect(result.stdout).toContain("wrote .llmwiki/profile.json");
    expect(result.stdout).toContain("created wiki/issues/");
    expect(result.stdout).toContain("next: llmwiki profile validate");
  });

  it("writes a profile that the CLI validates", async () => {
    const root = await roots.create("profile-init-validate");
    await runCLI(["profile", "init", "issue-tracker", "--entity", "issues"], root);

    const result = await runCLI(["profile", "validate"], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Profile 'issue-tracker' is valid");
  });

  it("refuses populated projects and leaves no profile", async () => {
    const root = await roots.create("profile-init-populated");
    await writeFile(path.join(root, "wiki/concepts/existing.md"), "# Existing\n", "utf8");

    const result = await runCLI(["profile", "init", "issue-tracker", "--entity", "issues"], root);

    await expectFailedInstall(result, root, /typed corpus is not empty/i);
  });

  it("rejects invalid names without creating profile state", async () => {
    const root = await roots.create("profile-init-invalid");

    const result = await runCLI(["profile", "init", "Issue Tracker", "--entity", "issues"], root);

    await expectFailedInstall(result, root, /lowercase letters, numbers, and hyphens/i);
  });

  it("help distinguishes profile authoring from templates", async () => {
    const root = await roots.create("profile-init-help");

    const result = await runCLI(["profile", "init", "--help"], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("minimal editable profile");
    expect(result.stdout).toContain("--entity");
  });
});
