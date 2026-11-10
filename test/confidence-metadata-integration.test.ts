/**
 * CLI-level integration tests for the confidence and contradiction metadata
 * lint rules introduced in the feature/confidence-metadata branch.
 *
 * Each test spins up a temporary directory that mimics a real wiki layout,
 * invokes `dist/cli.js lint` via execFile, and asserts on stdout/stderr and
 * exit code. No LLM calls are made — the lint command is purely static.
 *
 * Directory layout used by every fixture:
 *   <tmp>/
 *     wiki/concepts/<page>.md   ← the wiki page under test
 *     sources/                  ← empty dir so broken-citation rule finds nothing
 */

import { describe, it, expect } from "bun:test";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);
const BUILT_CLI = path.resolve("dist/cli.js");

// ---------------------------------------------------------------------------
// Fixture and runner helpers
// ---------------------------------------------------------------------------

/** Build YAML frontmatter lines shared by every fixture page. */
function sharedFrontmatterLines(): string[] {
  return ["sources: []", "createdAt: 2024-01-01", "updatedAt: 2024-01-01"];
}

/**
 * Assemble page markdown from a frontmatter key-value map and a body sentence.
 * Keeps test declarations short and avoids repeated boilerplate arrays.
 */
function buildPageContent(extraFields: Record<string, string>, body: string): string {
  const header = [
    "---",
    ...sharedFrontmatterLines(),
    ...Object.entries(extraFields).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
  ];
  return [...header, body].join("\n");
}

/**
 * Create a minimal wiki fixture in a temp directory containing one concept page.
 * Returns the absolute path to the project root.
 */
async function createWikiFixture(suffix: string, pageContent: string): Promise<string> {
  const root = path.join(tmpdir(), `llmwiki-ci-conf-${suffix}-${Date.now()}`);
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", `${suffix}.md`), pageContent, "utf-8");
  return root;
}

/** Run `llmwiki lint` in the given project root, always resolving (never rejecting). */
async function runLint(root: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync("bun", [BUILT_CLI, "lint"], { cwd: root });
    return { stdout, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: e.code ?? 1 };
  }
}

/** Remove a temp directory, ignoring errors on double-cleanup. */
async function removeFixture(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Assert that none of the confidence-metadata rule messages appear in output.
 * Used by both the "clean metadata" and "no metadata at all" tests.
 */
function assertNoConfidenceFindings(stdout: string): void {
  expect(stdout).not.toContain("below 0.5");
  expect(stdout).not.toContain("contradicts");
  expect(stdout).not.toContain("inferred paragraphs");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("confidence metadata — CLI lint integration", () => {
  // dist/cli.js is built once via the `bun run test` prebuild

  // -------------------------------------------------------------------------
  // low-confidence rule
  // -------------------------------------------------------------------------

  it("reports low-confidence finding when confidence is 0.2", async () => {
    const content = buildPageContent(
      { title: "Fragile Concept", summary: "Low confidence page.", confidence: "0.2" },
      "This page has very low confidence and should trigger the lint warning.",
    );
    const root = await createWikiFixture("low-conf", content);
    try {
      const { stdout } = await runLint(root);
      // The lint output prints the message text — assert on the key substrings.
      expect(stdout).toContain("0.20");
      expect(stdout).toContain("below 0.5");
    } finally {
      await removeFixture(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // contradicted-page rule
  // -------------------------------------------------------------------------

  it("reports contradiction finding when contradictedBy is set", async () => {
    // YAML list values need a literal multiline string, so we bypass buildPageContent.
    const content = [
      "---",
      ...sharedFrontmatterLines(),
      "title: Contradicted Concept",
      "summary: This concept contradicts another.",
      "contradictedBy:",
      "  - slug: other-page",
      "---",
      "",
      "This page is contradicted by other-page.",
    ].join("\n");
    const root = await createWikiFixture("contradiction", content);
    try {
      const { stdout } = await runLint(root);
      expect(stdout).toContain("other-page");
      expect(stdout).toContain("contradicts");
    } finally {
      await removeFixture(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // excess-inferred-paragraphs rule
  // -------------------------------------------------------------------------

  it("reports excess-inferred-paragraphs when the body has too many uncited prose paragraphs", async () => {
    // Each uncited prose paragraph contributes to the count; five exceeds
    // the max of two. Body is the only signal — the lint rule no longer
    // reads any frontmatter inferredParagraphs field.
    const body = [
      "First uncited prose paragraph.",
      "Second uncited prose paragraph.",
      "Third uncited prose paragraph.",
      "Fourth uncited prose paragraph.",
      "Fifth uncited prose paragraph.",
    ].join("\n\n");
    const content = buildPageContent(
      { title: "Inferred Concept", summary: "Mostly inferred." },
      body,
    );
    const root = await createWikiFixture("inferred", content);
    try {
      const { stdout } = await runLint(root);
      expect(stdout).toContain("5 inferred paragraphs");
      expect(stdout).toContain("max 2");
    } finally {
      await removeFixture(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // All-clean fixture — no new-rule findings
  // -------------------------------------------------------------------------

  it("reports no confidence-related findings for a page with good metadata", async () => {
    const content = buildPageContent(
      { title: "Clean Concept", summary: "Well-formed page.", confidence: "0.9", provenanceState: "extracted" },
      "This page meets all quality criteria and should trigger no confidence warnings.",
    );
    const root = await createWikiFixture("clean", content);
    try {
      const { stdout } = await runLint(root);
      assertNoConfidenceFindings(stdout);
    } finally {
      await removeFixture(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Backward compatibility — no confidence metadata at all
  // -------------------------------------------------------------------------

  it("does not surface new rule findings when pages have no confidence metadata", async () => {
    const content = buildPageContent(
      { title: "Legacy Concept", summary: "Older page without provenance fields." },
      "This is an existing page created before confidence metadata was introduced.",
    );
    const root = await createWikiFixture("legacy", content);
    try {
      const { stdout } = await runLint(root);
      // Pages without confidence fields must not trigger any of the new rules.
      assertNoConfidenceFindings(stdout);
    } finally {
      await removeFixture(root);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // All-flags fixture — all three new rules fire simultaneously
  // -------------------------------------------------------------------------

  it("surfaces all three new rule messages when a page violates all constraints", async () => {
    // The inferred-paragraphs rule now derives its count from the body —
    // include enough uncited prose paragraphs to trigger it alongside
    // the low-confidence and contradiction signals.
    const body = [
      "This page deliberately violates all three new lint rules.",
      "Second uncited prose paragraph here.",
      "Third uncited prose paragraph here.",
      "Fourth uncited prose paragraph here.",
    ].join("\n\n");
    const content = [
      "---",
      ...sharedFrontmatterLines(),
      "title: All Flags Concept",
      "summary: Triggers every new rule.",
      "confidence: 0.1",
      "contradictedBy:",
      "  - slug: rival-page",
      "---",
      "",
      body,
    ].join("\n");
    const root = await createWikiFixture("all-flags", content);
    try {
      const { stdout } = await runLint(root);
      // Each new rule emits a distinct message substring — assert on all three.
      expect(stdout).toContain("below 0.5");
      expect(stdout).toContain("contradicts");
      expect(stdout).toContain("inferred paragraphs");
    } finally {
      await removeFixture(root);
    }
  }, 30_000);
});
