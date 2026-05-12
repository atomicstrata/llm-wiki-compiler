/**
 * Subprocess-level integration tests for the lint cache side effect.
 *
 * Exercises the actual `llmwiki lint` CLI to confirm `.llmwiki/last-lint.json`
 * is written after a completed run, even when lint exits non-zero for findings,
 * and that the file lands at the documented path with the documented shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, readFile, stat } from "fs/promises";
import path from "path";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";
import { makeLintTempRoot } from "./fixtures/lint-temp-root.js";
import type { LintTempRoot } from "./fixtures/lint-temp-root.js";
import { LAST_LINT_FILE } from "../src/utils/constants.js";
import { LINT_CACHE_TIMESTAMP_PATTERN } from "../src/linter/cache.js";

let fx: LintTempRoot;

beforeEach(async () => {
  fx = await makeLintTempRoot("lint-cache-int");
});

afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true });
});

async function readCache(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(fx.root, LAST_LINT_FILE), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function cacheExists(): Promise<boolean> {
  try {
    await stat(path.join(fx.root, LAST_LINT_FILE));
    return true;
  } catch {
    return false;
  }
}

describe("`llmwiki lint` cache side effect", () => {
  it("writes the cache on a clean wiki and exits 0", async () => {
    const longBody = "This sentence is long enough to clear the empty-page threshold by a comfortable margin.";
    await fx.writeConceptPage("clean", `---\ntitle: Clean\nsummary: All good.\n---\n${longBody}`);

    const result = await runCLI(["lint"], fx.root);
    expectCLIExit(result, 0);

    const cached = await readCache();
    expect(cached.errors).toBe(0);
    expect(cached.warnings).toBe(0);
    expect(cached.at).toMatch(LINT_CACHE_TIMESTAMP_PATTERN);
  }, 30_000);

  it("writes the cache before exiting non-zero when lint finds errors", async () => {
    await fx.writeConceptPage(
      "broken",
      "---\ntitle: Broken\nsummary: Broken link.\n---\nSee [[Ghost Page]] for details, which is plenty long.",
    );

    const result = await runCLI(["lint"], fx.root);
    expectCLIFailure(result);

    expect(await cacheExists()).toBe(true);
    const cached = await readCache();
    expect((cached.errors as number) >= 1).toBe(true);
    expect(cached.at).toMatch(LINT_CACHE_TIMESTAMP_PATTERN);
  }, 30_000);

  it("creates .llmwiki/ recursively even when it did not exist", async () => {
    const result = await runCLI(["lint"], fx.root);
    expectCLIExit(result, 0);
    expect(await cacheExists()).toBe(true);
  }, 30_000);
});
