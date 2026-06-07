/**
 * Subprocess integration tests for `llmwiki next` and `llmwiki next --json`.
 *
 * Verifies the human and JSON renderers end-to-end through the compiled
 * CLI binary so the test pins what users and agents actually see. Each
 * test seeds its own temp directory (no `useTempRoot` chdir, since the
 * subprocess controls its own cwd).
 *
 * Critical invariants:
 *   - fresh temp dir produces `state: "fresh"` and writes no files
 *   - seeded sources, wiki pages, candidates, and lint errors each
 *     drive their expected primary state
 *   - JSON output is `version: 1` with the documented shape
 *   - human output never trips an ANSI escape into the JSON path
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { expectFreshDirUnchanged } from "./fixtures/project-state-helpers.js";
import {
  touchMarkdown,
  runNextJson,
  useNextTempDir,
} from "./fixtures/next-test-helpers.js";
import {
  SOURCES_DIR,
  CONCEPTS_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
  CANDIDATES_DIR,
} from "../src/utils/constants.js";

const env = useNextTempDir("next-cli");

/** Seed a candidate file directly so we don't depend on the compile pipeline. */
async function seedCandidate(root: string, id: string): Promise<void> {
  await mkdir(path.join(root, CANDIDATES_DIR), { recursive: true });
  const body = {
    id,
    title: "Stub",
    slug: id,
    summary: "stub",
    sources: ["x.md"],
    body: "stub",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(root, CANDIDATES_DIR, `${id}.json`), JSON.stringify(body), "utf-8");
}

/** Seed a lint cache directly so we don't need to run the linter pipeline. */
async function seedLintCache(root: string, errors: number, warnings: number): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  const entry = { warnings, errors, at: new Date().toISOString() };
  await writeFile(path.join(root, LAST_LINT_FILE), JSON.stringify(entry), "utf-8");
}

describe("`llmwiki next --json` — JSON envelope", () => {
  it("returns version 1 and state=fresh in an empty directory", async () => {
    const payload = await runNextJson(env.dir);
    expect(payload.version).toBe(1);
    expect(payload.state).toBe("fresh");
  });

  it("recommends quickstart with `source` placeholder for a fresh dir", async () => {
    const payload = await runNextJson(env.dir);
    const recommended = payload.recommended as Record<string, unknown>;
    const executable = recommended.executable as Record<string, unknown>;
    expect(executable.args).toEqual(["quickstart"]);
    expect(executable.placeholders).toEqual(["source"]);
  });

  it("classifies seeded sources as `sources-only`", async () => {
    await touchMarkdown(path.join(env.dir, SOURCES_DIR), "a.md");
    expect((await runNextJson(env.dir)).state).toBe("sources-only");
  });

  it("classifies seeded wiki pages as `wiki-ready`", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "a.md");
    const payload = await runNextJson(env.dir);
    expect(payload.state).toBe("wiki-ready");
    expect((payload.summary as Record<string, unknown>).freshness).toBeNull();
  });

  it("classifies a seeded pending candidate as `review-pending`", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "a.md");
    await seedCandidate(env.dir, "candidate-aabbccdd");
    expect((await runNextJson(env.dir)).state).toBe("review-pending");
  });

  it("classifies a lint cache with errors as `lint-attention`", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "a.md");
    await seedLintCache(env.dir, 3, 1);
    const payload = await runNextJson(env.dir);
    expect(payload.state).toBe("lint-attention");
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.hasLintCache).toBe(true);
    expect(summary.lint).toEqual({ warnings: 1, errors: 3, at: expect.any(String) });
    expect(summary.freshness).toBeNull();
  });

  it("emits no ANSI escapes in JSON output", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "a.md");
    const result = await runCLI(["next", "--json"], env.dir);
    expectCLIExit(result, 0);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

});

describe("`llmwiki next` — never mutates the project directory", () => {
  it("does not create .llmwiki/ in a fresh directory", async () => {
    const result = await runCLI(["next"], env.dir);
    expectCLIExit(result, 0);
    await expectFreshDirUnchanged(env.dir);
  });

  it("does not create .llmwiki/ when --json is requested either", async () => {
    const result = await runCLI(["next", "--json"], env.dir);
    expectCLIExit(result, 0);
    await expectFreshDirUnchanged(env.dir);
  });
});

describe("`llmwiki next` — human renderer", () => {
  it("prints the header, project line, and recommended action for a fresh dir", async () => {
    const result = await runCLI(["next"], env.dir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("llmwiki next");
    expect(result.stdout).toContain("Project: ");
    expect(result.stdout).toContain("Recommended next action:");
    expect(result.stdout).toContain("llmwiki quickstart <source>");
  });

  it("prints a review-pending summary line when candidates exist", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "a.md");
    await seedCandidate(env.dir, "candidate-aabbccdd");
    const result = await runCLI(["next"], env.dir);
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/review pending, 1 candidate\b/);
    expect(result.stdout).toContain("llmwiki review list");
  });
});
