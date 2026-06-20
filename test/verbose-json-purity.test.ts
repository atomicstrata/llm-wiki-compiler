/**
 * Regression tests: verbose output must never pollute machine-readable JSON
 * stdout paths.
 *
 * Covers `llmwiki context --json --verbose` and the LLMWIKI_VERBOSE=1 env
 * equivalent. Both must emit pure JSON on stdout (no `  · ` verbose marker
 * lines preceding the envelope).
 *
 * These are subprocess tests so the real quiet-mode guard on the compiled
 * binary is exercised — not just the in-process unit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

/** Marker emitted by verbose() calls — must never appear in JSON stdout. */
const VERBOSE_MARKER = "  · ";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "verbose-json-purity-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed one concept page so the context pack has something to report. */
async function seedConcept(slug: string, title: string): Promise<void> {
  await mkdir(path.join(tmpDir, CONCEPTS_DIR), { recursive: true });
  await writeFile(
    path.join(tmpDir, CONCEPTS_DIR, `${slug}.md`),
    `---\ntitle: ${title}\n---\n\nbody text here\n`,
    "utf-8",
  );
}

/**
 * Assert that running context with JSON output mode produces parseable stdout
 * with no verbose marker contamination. Shared by the --verbose flag test and
 * the LLMWIKI_VERBOSE env-var test to avoid duplicating the assertion block.
 */
async function assertJsonPurity(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<void> {
  const result = await runCLI(args, tmpDir, envOverrides);
  expectCLIExit(result, 0);
  expect(result.stdout, `verbose marker leaked into stdout:\n${result.stdout}`).not.toContain(
    VERBOSE_MARKER,
  );
  // Must parse as a single valid JSON object — no prefix lines.
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(parsed.version).toBe(1);
}

describe("context --json --verbose: stdout stays pure JSON", () => {
  it("JSON.parse(stdout) succeeds and no verbose marker appears on stdout", async () => {
    await seedConcept("alpha", "Alpha");
    await assertJsonPurity(["context", "alpha", "--json", "--verbose"]);
  });

  it("LLMWIKI_VERBOSE=1 with --json keeps stdout parseable", async () => {
    await seedConcept("beta", "Beta");
    await assertJsonPurity(["context", "beta", "--json"], { LLMWIKI_VERBOSE: "1" });
  });

  it("--verbose without --json still emits the verbose marker on stdout", async () => {
    await seedConcept("gamma", "Gamma");
    const result = await runCLI(["context", "gamma", "--verbose"], tmpDir);
    expectCLIExit(result, 0);
    // Human output path must NOT suppress verbose markers.
    expect(result.stdout).toContain(VERBOSE_MARKER);
  });
});
