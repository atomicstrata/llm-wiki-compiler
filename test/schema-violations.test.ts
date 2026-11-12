/**
 * Tests for schema violation attachment to review candidates (Finding 2).
 *
 * When `compile --review` runs, generated candidates are checked against the
 * schema's per-kind cross-link minimums. Violations are stored on the candidate
 * JSON record so `review show` can surface them before a reviewer approves.
 *
 * Tests here exercise:
 * - writeCandidate persists schemaViolations when provided
 * - readCandidate round-trips schemaViolations back
 * - reviewShowCommand prints violations when present
 * - reviewShowCommand prints nothing extra when no violations
 */

import { describe, it, expect } from "bun:test";
import { writeCandidate, readCandidate } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { captureShowOutput } from "./fixtures/review-show-helpers.js";
import type { LintResult } from "../src/linter/types.js";

const root = useTempRoot(["sources"]);

/** A minimal valid page body that passes validateWikiPage. */
const VALID_BODY = [
  "---",
  "title: Overview Page",
  'summary: "An overview."',
  "sources: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "Page body with content.",
].join("\n");

/** Minimal violation fixture mirroring what checkPageCrossLinks produces. */
const SAMPLE_VIOLATION: LintResult = {
  rule: "schema-cross-link-minimum",
  severity: "warning",
  file: "wiki/concepts/overview-page.md",
  message: 'Page kind "overview" requires at least 3 [[wikilinks]] but only 0 found.',
};

describe("candidate schema violations — persistence", () => {
  it("writeCandidate stores schemaViolations when provided", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Overview Page",
      slug: "overview-page",
      summary: "An overview.",
      sources: ["source.md"],
      body: VALID_BODY,
      schemaViolations: [SAMPLE_VIOLATION],
    });

    expect(candidate.schemaViolations).toHaveLength(1);
    expect(candidate.schemaViolations![0].rule).toBe("schema-cross-link-minimum");
  });

  it("readCandidate round-trips schemaViolations from disk", async () => {
    const written = await writeCandidate(root.dir, {
      title: "Overview Page",
      slug: "overview-page",
      summary: "An overview.",
      sources: ["source.md"],
      body: VALID_BODY,
      schemaViolations: [SAMPLE_VIOLATION],
    });

    const loaded = await readCandidate(root.dir, written.id);
    expect(loaded?.schemaViolations).toEqual([SAMPLE_VIOLATION]);
  });

  it("writeCandidate omits schemaViolations when not provided", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Overview Page",
      slug: "overview-page",
      summary: "An overview.",
      sources: ["source.md"],
      body: VALID_BODY,
    });

    expect(candidate.schemaViolations).toBeUndefined();
  });
});

describe("review show — schema violations display", () => {
  it("prints violations block when the candidate has schemaViolations", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Overview Page",
      slug: "overview-page",
      summary: "An overview.",
      sources: ["source.md"],
      body: VALID_BODY,
      schemaViolations: [SAMPLE_VIOLATION],
    });

    const allOutput = await captureShowOutput(candidate.id);
    expect(allOutput).toContain("Schema violations");
    expect(allOutput).toContain("requires at least 3");
  });

  it("does not print violations block when the candidate has no schemaViolations", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Clean Page",
      slug: "clean-page",
      summary: "No violations.",
      sources: ["source.md"],
      body: VALID_BODY,
    });

    const allOutput = await captureShowOutput(candidate.id);
    expect(allOutput).not.toContain("Schema violations");
  });
});
