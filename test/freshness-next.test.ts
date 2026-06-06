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
import { mkdir } from "fs/promises";
import path from "path";
import { touchMarkdown, runNextJson, useNextTempDir } from "./fixtures/next-test-helpers.js";
import { writeCorruptTestStateJson } from "./fixtures/state-json.js";
import { writeLintCache } from "../src/linter/cache.js";
import { CONCEPTS_DIR, LLMWIKI_DIR } from "../src/utils/constants.js";
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
  it("reports stale/orphaned counts from the lint cache in --json", async () => {
    await touchMarkdown(path.join(env.dir, CONCEPTS_DIR), "topic.md");
    await seedLintCache(env.dir, [
      { rule: "stale-page", severity: "warning", file: "topic.md", message: "stale" },
    ]);

    const payload = await runNextJson(env.dir);
    const s = payload.summary as Record<string, unknown>;
    expect(s.freshness).toEqual({ stalePages: 1, orphanedPages: 0 });

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
