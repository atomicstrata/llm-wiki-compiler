/**
 * Subprocess integration tests for freshness-surface behaviour in `llmwiki next`.
 *
 * Verifies that stale/orphaned counts from the lint cache appear in the
 * `--json` envelope and that a corrupt `.llmwiki/state.json` emits the
 * `state-unreadable` warning rather than being silently swallowed.
 *
 * Uses the real `writeLintCache` helper so the lint cache written here
 * always matches the production contract (including the `freshness` field
 * added in Task 2).
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { touchMarkdown, runNextJson, useNextTempDir } from "./fixtures/next-test-helpers.js";
import { writeCorruptTestStateJson } from "./fixtures/state-json.js";
import { writeLintCache } from "../src/linter/cache.js";
import { CONCEPTS_DIR, LLMWIKI_DIR, SOURCES_DIR } from "../src/utils/constants.js";
import type { LintResult } from "../src/linter/types.js";

const env = useNextTempDir("freshness-next");

/** Seed a lint cache for `dir` from the given results, deriving the severity counts. */
async function seedLintCache(dir: string, results: LintResult[]): Promise<void> {
  const warnings = results.filter((r) => r.severity === "warning").length;
  const errors = results.filter((r) => r.severity === "error").length;
  const info = results.filter((r) => r.severity === "info").length;
  await mkdir(path.join(dir, LLMWIKI_DIR), { recursive: true });
  await writeLintCache(dir, { errors, warnings, info, results });
}

describe("llmwiki next — freshness", () => {
  it("summary.lint has only {warnings,errors,at} and freshness stays top-level", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "topic.md");
    await seedLintCache(env.dir, [
      { rule: "stale-page", severity: "warning", file: "topic.md", message: "stale" },
    ]);

    const payload = await runNextJson(env.dir);
    const s = payload.summary as Record<string, unknown>;
    // summary.freshness surfaced at top level of summary
    expect(s.freshness).toEqual({ stalePages: 1, orphanedPages: 0 });
    // summary.lint must NOT leak the freshness field from LintCacheEntry
    const lint = s.lint as Record<string, unknown> | null;
    expect(lint).not.toBeNull();
    expect("freshness" in lint!).toBe(false);
    expect(Object.keys(lint!).sort()).toEqual(["at", "errors", "warnings"]);
    // stale-pages warning surfaced at the top level too
    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.some((w) => w.code === "stale-pages")).toBe(true);
  });

  it("emits state-unreadable (not silence) on corrupt state.json", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "topic.md");
    await writeCorruptTestStateJson(env.dir);

    const payload = await runNextJson(env.dir);
    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.some((w) => w.code === "state-unreadable")).toBe(true);
  });

  it("summary.freshness is null when no lint cache exists", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "topic.md");

    const payload = await runNextJson(env.dir);
    const s = payload.summary as Record<string, unknown>;
    expect(s.freshness).toBeNull();
  });

  it("reports zero counts and no stale-pages warning on a clean lint cache", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "topic.md");
    await seedLintCache(env.dir, []);

    const payload = await runNextJson(env.dir);
    const s = payload.summary as Record<string, unknown>;
    expect(s.freshness).toEqual({ stalePages: 0, orphanedPages: 0 });

    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.some((w) => w.code === "stale-pages")).toBe(false);
  });
});

/** Write a lint cache with an OLD timestamp and create a source file with a newer mtime. */
async function seedStaleFreshnessCache(dir: string): Promise<void> {
  // Write the lint cache JSON directly with an old `at` timestamp (well before "now").
  // This guarantees the sources/ dir mtime (created after) is > Date.parse(at).
  await mkdir(path.join(dir, LLMWIKI_DIR), { recursive: true });
  const entry = { warnings: 0, errors: 0, at: "2020-01-01T00:00:00.000Z", freshness: { stalePages: 0, orphanedPages: 0 } };
  await writeFile(path.join(dir, LLMWIKI_DIR, "last-lint.json"), JSON.stringify(entry), "utf-8");
  // Create sources/ dir with a file — its mtime is "now", which is > 2020-01-01.
  await mkdir(path.join(dir, SOURCES_DIR), { recursive: true });
  await writeFile(path.join(dir, SOURCES_DIR, "new-source.md"), "# New", "utf-8");
}

/** Run next --json and return whether warnings include a given code. */
async function hasWarningCode(dir: string, code: string): Promise<boolean> {
  const payload = await runNextJson(dir);
  const warnings = payload.warnings as Array<Record<string, unknown>>;
  return warnings.some((w) => w.code === code);
}

describe("llmwiki next — freshness-cache-stale warning", () => {
  it("emits freshness-cache-stale when sources/ is newer than the last lint", async () => {
    await seedStaleFreshnessCache(env.dir);
    expect(await hasWarningCode(env.dir, "freshness-cache-stale")).toBe(true);
  });

  it("does NOT emit freshness-cache-stale when lint cache is recent (no sources/ dir)", async () => {
    // Seed a lint cache with a recent timestamp (now), but no sources/ dir exists,
    // so latestSourceMtimeMs is null and the heuristic does not fire.
    await seedLintCache(env.dir, []);
    expect(await hasWarningCode(env.dir, "freshness-cache-stale")).toBe(false);
  });
});
