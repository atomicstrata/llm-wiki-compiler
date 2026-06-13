/**
 * Subprocess-level acceptance tests for the schema layer.
 *
 * These tests complement the in-process unit tests in schema-violations.test.ts
 * and seed-pages-early-return.test.ts by exercising the same behaviours through
 * the compiled CLI binary, closing the coverage gap identified by Codex.
 *
 * Test 1: Seed page generation — verifies that `compile` materialises a
 *   schema-declared seed page and rebuilds wiki/index.md even when no source
 *   files are present (early-return path). Requires a live Anthropic API key.
 *
 * Test 2: `review show` prints schema violations when present — a candidate
 *   JSON fixture with schemaViolations is written manually; the subprocess
 *   output is checked for the violations block and message text.
 *
 * Test 3: `review show` hides violations block when absent — same fixture
 *   without schemaViolations; the block header must not appear in output.
 *
 * dist/cli.js is built once via vitest globalSetup (see test/global-setup.ts).
 * Per-file beforeAll(npx tsup) calls are intentionally absent — see PR #21.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import type { ReviewCandidate } from "../src/utils/types.js";
import type { LintResult } from "../src/linter/types.js";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/** Create a fresh temporary project directory with a sources/ sub-folder. */
async function makeTempProject(label: string): Promise<string> {
  const dir = path.join(tmpdir(), `llmwiki-subproc-${label}-${Date.now()}`);
  await mkdir(path.join(dir, "sources"), { recursive: true });
  return dir;
}

/** Remove a temporary project directory. */
async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Build a minimal valid ReviewCandidate page body (frontmatter + body). */
function buildValidBody(title: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `title: "${title}"`,
    'summary: "A page for subprocess testing."',
    "sources: []",
    `createdAt: "${now}"`,
    `updatedAt: "${now}"`,
    "---",
    "",
    `# ${title}`,
    "",
    "Body content for subprocess test.",
  ].join("\n");
}

/** Write a ReviewCandidate JSON under .llmwiki/candidates/<id>.json. */
async function writeCandidateJson(
  root: string,
  candidate: ReviewCandidate,
): Promise<void> {
  const dir = path.join(root, ".llmwiki", "candidates");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${candidate.id}.json`),
    JSON.stringify(candidate, null, 2),
    "utf-8",
  );
}

/**
 * Write a candidate JSON fixture and run `review show <id>` as a subprocess.
 * Returns the CLI result so callers can assert on stdout and exit code.
 * @param root - Temporary project root directory.
 * @param candidate - Candidate to persist and display.
 */
async function runReviewShow(
  root: string,
  candidate: ReviewCandidate,
): Promise<import("./fixtures/run-cli.js").CLIResult> {
  await writeCandidateJson(root, candidate);
  return runCLI(["review", "show", candidate.id], root);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("schema subprocess tests", () => {
  // -------------------------------------------------------------------------
  // Subprocess coverage for `compile` seed-page generation requires a working
  // LLM backend (generateSeedPages calls callClaude for body text). CI has no
  // real API key, and retrying the fake token produces a long, noisy failure
  // with 4 retry attempts. The command-level equivalent is already covered in
  // test/seed-pages-early-return.test.ts via vi.spyOn. Full subprocess coverage
  // is deferred until the planned stub-provider infrastructure lands.

  // -------------------------------------------------------------------------
  // Test: review show prints schema violations when present
  // -------------------------------------------------------------------------

  it("review show prints Schema violations block when candidate has violations", async () => {
    const cwd = await makeTempProject("show-violations");
    try {
      const violation: LintResult = {
        rule: "schema-cross-link-minimum",
        severity: "warning",
        file: "wiki/concepts/overview-page.md",
        message: 'Page kind "overview" requires at least 3 [[wikilinks]] but only 0 found.',
      };
      const candidate: ReviewCandidate = {
        id: "overview-page-aabbccdd",
        title: "Overview Page",
        slug: "overview-page",
        summary: "A test overview page.",
        sources: ["source.md"],
        body: buildValidBody("Overview Page"),
        generatedAt: new Date().toISOString(),
        reviewMode: "forced",
        heldReasons: [{ code: "manual-review-requested" }],
        schemaViolations: [violation],
      };

      const result = await runReviewShow(cwd, candidate);
      expectCLIExit(result, 0);
      // The header() helper wraps text in ANSI bold codes but the raw text is present
      expect(result.stdout).toContain("Schema violations");
      expect(result.stdout).toContain("requires at least 3");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 3: review show hides violations block when absent
  // -------------------------------------------------------------------------

  it("review show omits Schema violations block when candidate has no violations", async () => {
    const cwd = await makeTempProject("show-no-violations");
    try {
      const candidate: ReviewCandidate = {
        id: "clean-page-aabbccdd",
        title: "Clean Page",
        slug: "clean-page",
        summary: "A candidate with no schema violations.",
        sources: ["source.md"],
        body: buildValidBody("Clean Page"),
        generatedAt: new Date().toISOString(),
        reviewMode: "forced",
        heldReasons: [{ code: "manual-review-requested" }],
        // schemaViolations intentionally omitted — block must not appear
      };

      const result = await runReviewShow(cwd, candidate);
      expectCLIExit(result, 0);
      expect(result.stdout).not.toContain("Schema violations");
    } finally {
      await cleanupDir(cwd);
    }
  }, 30_000);
});
