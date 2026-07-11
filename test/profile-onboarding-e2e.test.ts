/**
 * @file test/profile-onboarding-e2e.test.ts
 * @description Proves the documented five-step CLP onboarding flow.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { runCLI } from "./fixtures/run-cli.js";

const ISSUE_PATH = "wiki/issues/explain-first-profile.md";
const ISSUE_BODY = `---
title: Explain the first profile
---

Explain why this project uses custom issue pages and what information every issue should contain.
`;

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function scaffoldTutorialProject(): Promise<void> {
  root = await makeTempRoot("profile-onboarding-e2e");
  const init = await runCLI(["profile", "init", "issue-tracker", "--entity", "issues"], root);
  expect(init.code).toBe(0);
  const validate = await runCLI(["profile", "validate"], root);
  expect(validate.stdout).toContain("Profile 'issue-tracker' is valid");
  await writeFile(path.join(root, ISSUE_PATH), ISSUE_BODY, "utf8");
}

async function addRequiredPriority(): Promise<void> {
  const profilePath = path.join(root, PROFILE_FILE);
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as ProfilePack;
  const issue = profile.entities.issues;
  issue.requiredFields = [...(issue.requiredFields ?? []), "priority"];
  issue.fields = { ...issue.fields, priority: {
    type: "enum",
    enum: ["low", "normal", "high"],
  } };
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

describe("CLP profile onboarding", () => {
  it("runs scaffold, validation, page, deliberate error, repair, and viewer proof", async () => {
    await scaffoldTutorialProject();

    const firstLint = await runCLI(["lint"], root);
    expect(firstLint.code).toBe(0);
    expect(firstLint.stdout).toMatch(/0 error\(s\).*0 warning\(s\).*0 info/s);
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.profile?.entityCounts.issues).toBe(1);
    expect(snapshot.graph.nodes.some((node) => node.id === "issues/explain-first-profile"))
      .toBe(true);

    await addRequiredPriority();
    expect((await runCLI(["profile", "validate"], root)).code).toBe(0);
    const brokenLint = await runCLI(["lint"], root);
    expect(brokenLint.code).toBe(0);
    expect(brokenLint.stdout).toMatch(/Required field "priority" is missing from frontmatter/);
    expect(brokenLint.stdout).toMatch(/0 error\(s\).*1 warning\(s\).*0 info/s);

    await writeFile(path.join(root, ISSUE_PATH), ISSUE_BODY.replace("title:", "priority: normal\ntitle:"), "utf8");
    expect((await runCLI(["profile", "validate"], root)).code).toBe(0);
    const repairedLint = await runCLI(["lint"], root);
    expect(repairedLint.code).toBe(0);
    expect(repairedLint.stdout).toMatch(/0 error\(s\).*0 warning\(s\).*0 info/s);
  });
});
