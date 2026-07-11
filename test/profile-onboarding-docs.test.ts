/**
 * @file test/profile-onboarding-docs.test.ts
 * @description Prevents the CLP beginner tutorial from drifting from the CLI.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStarterProfileJson } from "../src/profile/scaffold.js";

const DOCS_ROOT = path.join(process.cwd(), "docs");
const GUIDE_PATH = path.join(DOCS_ROOT, "guides/clp/build-your-first-profile.mdx");
const DATA_PATH = path.join(DOCS_ROOT, "snippets/profile-onboarding-data.mdx");

async function text(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

function exportedProfile(source: string): string {
  const match = source.match(/export const starterProfileText = `([\s\S]*?)`;/);
  if (!match) throw new Error("starterProfileText export is missing");
  return `${match[1]}\n`;
}

describe("profile onboarding documentation", () => {
  it("uses the scaffold's canonical profile bytes", async () => {
    const data = await text(DATA_PATH);

    expect(exportedProfile(data)).toBe(canonicalStarterProfileJson("issue-tracker", "issues"));
  });

  it("documents every command in the tested five-step flow", async () => {
    const guide = await text(GUIDE_PATH);

    for (const command of [
      "llmwiki --version",
      "llmwiki profile init issue-tracker --entity issues",
      "llmwiki profile validate",
      "llmwiki lint",
      "llmwiki view --open",
    ]) expect(guide).toContain(command);
  });

  it("provides complete human and agent explorer variants", async () => {
    const guide = await text(GUIDE_PATH);
    const data = await text(DATA_PATH);

    expect(guide).toContain('<Visibility for="humans">');
    expect(guide).toContain('<Visibility for="agents">');
    for (const title of [
      "File format version",
      "Profile name",
      "Kinds of pages",
      "Where pages live",
      "Required page title",
    ]) {
      expect(data).toContain(title);
      expect(guide).toContain(title);
    }
  });

  it("publishes the tutorial first in the collapsed CLP guides group", async () => {
    const docs = JSON.parse(await text(path.join(DOCS_ROOT, "docs.json"))) as Record<string, unknown>;
    const serialized = JSON.stringify(docs);

    expect(serialized).toContain("guides/clp/build-your-first-profile");
    expect(serialized.indexOf("guides/clp/build-your-first-profile"))
      .toBeLessThan(serialized.indexOf("guides/autosci-research-workflow"));
  });
});
