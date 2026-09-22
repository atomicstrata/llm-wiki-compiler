/**
 * @file test/lint-profile-scope-parity.test.ts
 * @description Existing profiles do not implicitly widen public lint coverage.
 * New explicit wiki-wide checks and fix plans can inspect typed entity pages.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lint, lintBothViews } from "../src/linter/index.js";
import { planLintFixes } from "../src/linter/fix-plan.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** Install a public v1 profile and a broken typed-page link. */
async function installProfilePage(): Promise<void> {
  await mkdir(path.join(root.dir, ".llmwiki"), { recursive: true });
  await mkdir(path.join(root.dir, "wiki", "papers"), { recursive: true });
  await writeFile(path.join(root.dir, ".llmwiki", "profile.json"), JSON.stringify({
    schemaVersion: 1, profileId: "research",
    entities: { papers: { directory: "wiki/papers" } },
  }));
  await writeFile(path.join(root.dir, "wiki", "papers", "draft.md"),
    '---\ntitle: "Draft"\n---\nA link to [[Absent Paper]].\n');
}

describe("existing profile lint scope", () => {
  it("keeps flat lint unchanged while explicit expanded checks find typed links", async () => {
    await installProfilePage();
    const legacy = await lint(root.dir);
    const expanded = await lintBothViews(root.dir, "wiki-wide");

    expect(legacy.results.filter((result) => result.rule === "broken-wikilink")).toEqual([]);
    expect(expanded.summary.results.filter((result) => result.rule === "broken-wikilink"))
      .toHaveLength(1);
    expect(await planLintFixes(root.dir)).toHaveLength(1);
    expect(await planLintFixes(root.dir, "generic")).toEqual([]);
  });
});
