/**
 * Tests for claim-level provenance: parsing of `^[file.md:42-58]` and
 * `^[file.md#L42-L58]` markers, the inspectProvenance utility, the existing
 * paragraph-level fallback, and the new malformed-claim-citation lint rule.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import {
  extractCitations,
  extractClaimCitations,
  inspectProvenance,
  isMalformedCitationEntry,
} from "../src/utils/markdown.js";
import {
  checkBrokenCitations,
  checkMalformedClaimCitations,
} from "../src/linter/rules.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

describe("extractClaimCitations parser", () => {
  it("returns empty array when there are no markers", () => {
    expect(extractClaimCitations("Just prose, no markers.")).toEqual([]);
  });

  it("parses paragraph form as a span without lines", () => {
    const citations = extractClaimCitations("A claim. ^[paper.md]");
    expect(citations).toHaveLength(1);
    expect(citations[0].spans).toEqual([{ file: "paper.md" }]);
  });

  it("parses colon line-range form into a span with lines", () => {
    const citations = extractClaimCitations("A claim. ^[paper.md:42-58]");
    expect(citations[0].spans).toEqual([
      { file: "paper.md", lines: { start: 42, end: 58 } },
    ]);
  });

  it("parses hash #L line-range form into a span with lines", () => {
    const citations = extractClaimCitations("A claim. ^[paper.md#L10-L12]");
    expect(citations[0].spans).toEqual([
      { file: "paper.md", lines: { start: 10, end: 12 } },
    ]);
  });

  it("treats a single-line span as start === end", () => {
    const citations = extractClaimCitations("A claim. ^[paper.md:7]");
    expect(citations[0].spans).toEqual([
      { file: "paper.md", lines: { start: 7, end: 7 } },
    ]);
  });

  it("handles mixed paragraph + claim spans inside one marker", () => {
    const citations = extractClaimCitations("A claim. ^[a.md, b.md:1-3]");
    expect(citations[0].spans).toEqual([
      { file: "a.md" },
      { file: "b.md", lines: { start: 1, end: 3 } },
    ]);
  });

  it("treats comma-separated line numbers as two individual line spans on the same file", () => {
    const citations = extractClaimCitations("A claim. ^[source.md:1, 12]");
    expect(citations).toHaveLength(1);
    expect(citations[0].raw).toBe("source.md:1, 12");
    expect(citations[0].spans).toEqual([
      { file: "source.md", lines: { start: 1, end: 1 } },
      { file: "source.md", lines: { start: 12, end: 12 } },
    ]);
  });

  it("treats compact comma line list (no space) as individual line spans", () => {
    const citations = extractClaimCitations("A claim. ^[source.md:1,12]");
    expect(citations).toHaveLength(1);
    expect(citations[0].spans).toEqual([
      { file: "source.md", lines: { start: 1, end: 1 } },
      { file: "source.md", lines: { start: 12, end: 12 } },
    ]);
  });
});

describe("extractCitations backwards compatibility", () => {
  it("still returns flat filename list for paragraph form", () => {
    expect(extractCitations("Para. ^[source.md]")).toEqual(["source.md"]);
  });

  it("strips span suffixes when collecting filenames", () => {
    const body = "Claim one. ^[paper.md:1-3]\n\nClaim two. ^[paper.md#L9-L11]";
    expect(extractCitations(body)).toEqual(["paper.md"]);
  });

  it("collects unique filenames across paragraph and claim forms", () => {
    const body = "P1. ^[a.md]\n\nP2. ^[b.md:5-7, a.md]";
    const result = extractCitations(body);
    expect(result.sort()).toEqual(["a.md", "b.md"]);
  });

  it("does not emit a bogus file entry for comma-separated line numbers", () => {
    expect(extractCitations("A claim. ^[source.md:1, 12]")).toEqual(["source.md"]);
  });
});

describe("inspectProvenance", () => {
  it("groups spans by source file", () => {
    const body = "Claim. ^[a.md:1-3]\n\nClaim. ^[a.md:8-9]\n\nClaim. ^[b.md:2-4]";
    const map = inspectProvenance(body);
    expect(map.get("a.md")).toEqual([
      { start: 1, end: 3 },
      { start: 8, end: 9 },
    ]);
    expect(map.get("b.md")).toEqual([{ start: 2, end: 4 }]);
  });

  it("dedupes identical ranges across markers", () => {
    const body = "C1. ^[a.md:1-2]\n\nC2. ^[a.md:1-2]";
    expect(inspectProvenance(body).get("a.md")).toEqual([{ start: 1, end: 2 }]);
  });

  it("records paragraph-only citations as empty range list", () => {
    const map = inspectProvenance("Para. ^[a.md]");
    expect(map.get("a.md")).toEqual([]);
  });

  it("records comma-separated line numbers as two individual ranges on the same file", () => {
    const map = inspectProvenance("Claim. ^[source.md:1, 12]");
    expect(map.get("source.md")).toEqual([
      { start: 1, end: 1 },
      { start: 12, end: 12 },
    ]);
  });
});

describe("isMalformedCitationEntry", () => {
  it("accepts paragraph form", () => {
    expect(isMalformedCitationEntry("file.md")).toBe(false);
  });

  it("accepts colon and hash span forms", () => {
    expect(isMalformedCitationEntry("file.md:1-3")).toBe(false);
    expect(isMalformedCitationEntry("file.md#L1-L3")).toBe(false);
  });

  it("accepts single-line span (start === end)", () => {
    expect(isMalformedCitationEntry("file.md:1-1")).toBe(false);
  });

  it("accepts multi-line span", () => {
    expect(isMalformedCitationEntry("file.md:1-5")).toBe(false);
  });

  it("rejects non-numeric line ranges", () => {
    expect(isMalformedCitationEntry("file.md:abc")).toBe(true);
  });

  it("rejects half-baked hash forms", () => {
    expect(isMalformedCitationEntry("file.md#X9")).toBe(true);
  });

  it("rejects line 0 in colon form (lines are 1-indexed)", () => {
    expect(isMalformedCitationEntry("file.md:0-3")).toBe(true);
  });

  it("rejects end before start in colon form", () => {
    expect(isMalformedCitationEntry("file.md:5-3")).toBe(true);
  });

  it("rejects line 0 in hash form", () => {
    expect(isMalformedCitationEntry("file.md#L0-L3")).toBe(true);
  });

  it("accepts comma-separated line numbers as a valid span form", () => {
    expect(isMalformedCitationEntry("file.md:8,12")).toBe(false);
    expect(isMalformedCitationEntry("file.md:1, 5")).toBe(false);
  });
});

describe("extractClaimCitations with invalid line ranges", () => {
  it("drops a marker whose only entry has line 0", () => {
    // Invalid entries produce no spans, so the citation is not included in results.
    // The linter's checkMalformedClaimCitations flags these independently.
    const citations = extractClaimCitations("A claim. ^[file.md:0-3]");
    expect(citations).toHaveLength(0);
  });

  it("drops a marker whose only entry has end before start", () => {
    const citations = extractClaimCitations("A claim. ^[file.md:5-3]");
    expect(citations).toHaveLength(0);
  });

  it("drops a marker whose only entry has hash-form line 0", () => {
    const citations = extractClaimCitations("A claim. ^[file.md#L0-L3]");
    expect(citations).toHaveLength(0);
  });
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await makeTempRoot("claim-prov");
  await mkdir(path.join(tmpDir, "sources"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeConcept(slug: string, content: string): Promise<void> {
  await writeFile(path.join(tmpDir, "wiki", "concepts", `${slug}.md`), content);
}

async function writeSource(name: string, content: string): Promise<void> {
  await writeFile(path.join(tmpDir, "sources", name), content);
}

describe("checkBrokenCitations with claim-level spans", () => {
  it("resolves claim-level citations to the underlying source file", async () => {
    await writeSource("paper.md", "# Paper\nLine 2\nLine 3");
    await writeConcept(
      "ok",
      "---\ntitle: OK\n---\nA claim. ^[paper.md:2-3]",
    );

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("flags claim-level citations whose source file is missing", async () => {
    await writeConcept(
      "bad",
      "---\ntitle: Bad\n---\nA claim. ^[ghost.md:1-2]",
    );

    const results = await checkBrokenCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("broken-citation");
    expect(results[0].message).toContain("ghost.md");
  });
});

describe("checkMalformedClaimCitations", () => {
  it("returns no results for valid paragraph and claim forms", async () => {
    await writeSource("paper.md", "content");
    await writeConcept(
      "good",
      "---\ntitle: G\n---\nP1. ^[paper.md]\n\nP2. ^[paper.md:1-3]\n\nP3. ^[paper.md#L1-L3]",
    );

    const results = await checkMalformedClaimCitations(tmpDir);
    expect(results).toHaveLength(0);
  });

  it("flags malformed line-range syntax", async () => {
    await writeConcept(
      "broken",
      "---\ntitle: B\n---\nClaim. ^[paper.md:abc]",
    );

    const results = await checkMalformedClaimCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("malformed-claim-citation");
    expect(results[0].severity).toBe("error");
  });

  it("flags line-0 start in colon form as malformed", async () => {
    await writeConcept(
      "line-zero",
      "---\ntitle: LZ\n---\nClaim. ^[paper.md:0-3]",
    );

    const results = await checkMalformedClaimCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("malformed-claim-citation");
  });

  it("flags reversed range (end before start) as malformed", async () => {
    await writeConcept(
      "reversed",
      "---\ntitle: Rev\n---\nClaim. ^[paper.md:5-3]",
    );

    const results = await checkMalformedClaimCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("malformed-claim-citation");
  });

  it("flags line-0 in hash form as malformed", async () => {
    await writeConcept(
      "hash-zero",
      "---\ntitle: HZ\n---\nClaim. ^[paper.md#L0-L3]",
    );

    const results = await checkMalformedClaimCitations(tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].rule).toBe("malformed-claim-citation");
  });
});

/** 3-line source content used in out-of-bounds span tests. */
const THREE_LINE_SOURCE = "Line 1\nLine 2\nLine 3";

/** 100-line source content used in in-bounds span test. */
const HUNDRED_LINE_SOURCE = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");

/**
 * Write src.md with the given content and a concept page citing it with the
 * given marker text, then run checkBrokenCitations and return the findings.
 */
async function lintWithSpan(sourceContent: string, marker: string): Promise<import("../src/linter/types.js").LintResult[]> {
  await writeSource("src.md", sourceContent);
  await writeConcept("page", `---\ntitle: T\n---\nClaim. ${marker}`);
  return checkBrokenCitations(tmpDir);
}

/** Assert that a single out-of-bounds broken-citation finding was emitted. */
function expectOutOfBounds(results: import("../src/linter/types.js").LintResult[]): void {
  expect(results).toHaveLength(1);
  expect(results[0].rule).toBe("broken-citation");
  expect(results[0].message).toContain("out of bounds");
}

describe("checkBrokenCitations — out-of-bounds span detection", () => {
  it("reports no findings for a colon span within the source line count", async () => {
    const results = await lintWithSpan(THREE_LINE_SOURCE, "^[src.md:1-3]");
    expect(results).toHaveLength(0);
  });

  it("flags a colon span whose end exceeds the source line count", async () => {
    const results = await lintWithSpan(THREE_LINE_SOURCE, "^[src.md:1-5]");
    expectOutOfBounds(results);
    expect(results[0].message).toContain("3 lines");
  });

  it("flags a colon span entirely beyond the source line count", async () => {
    const results = await lintWithSpan(THREE_LINE_SOURCE, "^[src.md:5-7]");
    expectOutOfBounds(results);
  });

  it("reports no findings for a hash span within the source line count", async () => {
    const results = await lintWithSpan(THREE_LINE_SOURCE, "^[src.md#L1-L3]");
    expect(results).toHaveLength(0);
  });

  it("flags a hash span whose end exceeds the source line count", async () => {
    const results = await lintWithSpan(THREE_LINE_SOURCE, "^[src.md#L4-L6]");
    expectOutOfBounds(results);
  });

  it("reports no findings for a span well within a 100-line source", async () => {
    const results = await lintWithSpan(HUNDRED_LINE_SOURCE, "^[src.md:42-58]");
    expect(results).toHaveLength(0);
  });
});
