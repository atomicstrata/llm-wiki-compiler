/**
 * Tests for provenance violation attachment to review candidates
 * (codex audit follow-up to the schema-overlap cluster review).
 *
 * `compile --review` previously only attached schema-cross-link
 * violations to candidates. Citation-level lint (malformed claim
 * citations, broken-source / out-of-bounds spans) only fired on the
 * post-promotion compile, so reviewers approved candidates without
 * seeing these issues. The fix runs both lint passes in
 * persistReviewCandidate and persists the citation findings under
 * `provenanceViolations` for `review show` to surface.
 *
 * Coverage:
 *   - per-page lint helpers detect malformed claim citations and
 *     broken / out-of-bounds spans on in-memory bodies
 *   - writeCandidate persists / omits provenanceViolations correctly
 *   - readCandidate round-trips provenanceViolations
 *   - reviewShowCommand prints the new block when populated
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import {
  checkPageMalformedCitations,
  checkPageBrokenCitations,
} from "../src/linter/rules.js";
import { writeCandidate, readCandidate } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { captureShowOutput } from "./fixtures/review-show-helpers.js";
import type { LintResult } from "../src/linter/types.js";

const root = useTempRoot(["sources"]);

const VALID_BODY = [
  "---",
  "title: Sample",
  'summary: "A sample."',
  "sources: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "Body.",
].join("\n");

const SAMPLE_PROVENANCE_VIOLATION: LintResult = {
  rule: "malformed-claim-citation",
  severity: "error",
  file: "wiki/concepts/sample.md",
  message: "Malformed claim citation ^[file.md:abc] — expected file.md, file.md:N-N, or file.md#LN-LN",
};

describe("checkPageMalformedCitations — pure body lint", () => {
  it("flags entries that don't parse as paragraph or claim grammar", () => {
    const body =
      "Para one. ^[source.md:abc]\n\nPara two. ^[ok.md]\n\nPara three. ^[multi.md, broken.md#X]";
    const findings = checkPageMalformedCitations(body, "wiki/concepts/test.md");
    // Two malformed entries: `:abc` and `#X` (not `#L<num>`).
    expect(findings).toHaveLength(2);
    expect(findings[0].rule).toBe("malformed-claim-citation");
    expect(findings.every((f) => f.severity === "error")).toBe(true);
  });

  it("returns empty for clean paragraph and claim citations", () => {
    const body =
      "Para one. ^[source.md]\n\nPara two. ^[other.md:1-3]\n\nPara three. ^[third.md#L10-L20]";
    expect(checkPageMalformedCitations(body, "wiki/concepts/test.md")).toEqual([]);
  });

  it("accepts comma-separated line lists the normalizer emits", () => {
    const body = "Para one. ^[file.md:12,15,20]";
    expect(checkPageMalformedCitations(body, "wiki/concepts/test.md")).toEqual([]);
  });

  it("still flags comma lists containing line 0", () => {
    const body = "Para one. ^[file.md:0,5]";
    const findings = checkPageMalformedCitations(body, "wiki/concepts/test.md");
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("malformed-claim-citation");
  });
});

describe("checkPageBrokenCitations — pure body lint", () => {
  it("flags citations referencing source files that don't exist", async () => {
    const sourcesDir = path.join(root.dir, "sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(path.join(sourcesDir, "exists.md"), "line1\nline2\nline3\n", "utf-8");

    const body = "Para one. ^[exists.md]\n\nPara two. ^[missing.md]";
    const findings = await checkPageBrokenCitations(
      body,
      "wiki/concepts/test.md",
      sourcesDir,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("broken-citation");
    expect(findings[0].message).toContain("missing.md");
  });

  it("flags claim spans that exceed the source file's line count", async () => {
    const sourcesDir = path.join(root.dir, "sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(path.join(sourcesDir, "short.md"), "line1\nline2\nline3\n", "utf-8");

    const body = "Para. ^[short.md:10-12]";
    const findings = await checkPageBrokenCitations(
      body,
      "wiki/concepts/test.md",
      sourcesDir,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message.toLowerCase()).toContain("out of bounds");
  });

  it("returns empty when all citations resolve and stay in-range", async () => {
    const sourcesDir = path.join(root.dir, "sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(path.join(sourcesDir, "ok.md"), "a\nb\nc\nd\ne\n", "utf-8");

    const body = "Para. ^[ok.md:1-3]";
    expect(await checkPageBrokenCitations(body, "wiki/concepts/test.md", sourcesDir)).toEqual(
      [],
    );
  });
});

describe("candidate provenance violations — persistence", () => {
  it("writeCandidate stores provenanceViolations when provided", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Sample",
      slug: "sample",
      summary: "A sample.",
      sources: ["source.md"],
      body: VALID_BODY,
      provenanceViolations: [SAMPLE_PROVENANCE_VIOLATION],
    });

    expect(candidate.provenanceViolations).toHaveLength(1);
    expect(candidate.provenanceViolations![0].rule).toBe("malformed-claim-citation");
  });

  it("readCandidate round-trips provenanceViolations from disk", async () => {
    const written = await writeCandidate(root.dir, {
      title: "Sample",
      slug: "sample",
      summary: "A sample.",
      sources: ["source.md"],
      body: VALID_BODY,
      provenanceViolations: [SAMPLE_PROVENANCE_VIOLATION],
    });

    const loaded = await readCandidate(root.dir, written.id);
    expect(loaded?.provenanceViolations).toEqual([SAMPLE_PROVENANCE_VIOLATION]);
  });

  it("writeCandidate omits provenanceViolations when not provided", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Sample",
      slug: "sample",
      summary: "A sample.",
      sources: ["source.md"],
      body: VALID_BODY,
    });

    expect(candidate.provenanceViolations).toBeUndefined();
  });
});

describe("review show — provenance violations display", () => {
  it("prints provenance block when the candidate has provenanceViolations", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Sample",
      slug: "sample",
      summary: "A sample.",
      sources: ["source.md"],
      body: VALID_BODY,
      provenanceViolations: [SAMPLE_PROVENANCE_VIOLATION],
    });

    const allOutput = await captureShowOutput(candidate.id);
    expect(allOutput).toContain("Provenance violations");
    expect(allOutput).toContain("Malformed claim citation");
  });

  it("does not print provenance block when the candidate has no provenanceViolations", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Clean",
      slug: "clean",
      summary: "No violations.",
      sources: ["source.md"],
      body: VALID_BODY,
    });

    const allOutput = await captureShowOutput(candidate.id);
    expect(allOutput).not.toContain("Provenance violations");
  });
});
