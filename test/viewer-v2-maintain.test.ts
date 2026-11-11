/**
 * The v2 reviews and source-changes screens, rendered to static markup in
 * their empty and populated states, plus the cockpit's pure rules: the
 * verdict on a proposal's checks, the quoted terminal command, and the
 * metadata split.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewsList, targetDirectoryOf } from "../viewer-v2/src/reviews-view.js";
import { metadataBlock, reviewCommand, reviewMessage } from "../viewer-v2/src/source-changes-model.js";
import { SourceCockpit } from "../viewer-v2/src/source-changes-view.js";
import { reviewCandidate, reviewsEnvelope, sourceChangePage, sourceChangesReport, text } from "./fixtures/viewer-v2-fixtures.js";

describe("ReviewsList", () => {
  it("shows the teaching empty state when nothing is pending", () => {
    const html = renderToStaticMarkup(createElement(ReviewsList, { payload: reviewsEnvelope([]) }));
    expect(html).toContain("Nothing awaiting review");
    expect(html).toContain("$ llmwiki compile --review");
    expect(html).not.toContain("#/source-changes");
  });

  it("lists candidates with their provenance, destination, reasons, and the cap notice", () => {
    const typed = reviewCandidate({ id: "c2", title: "", slug: "beta", summary: "  A summary ", sources: ["a.md", "b.md"], targetEntityType: "papers", heldReasons: [{ code: "mystery" }] });
    const payload = reviewsEnvelope([reviewCandidate(), typed], { total: 5, sourceChanges: true });
    const html = renderToStaticMarkup(createElement(ReviewsList, { payload }));
    const visible = text(html);
    expect(visible).toContain("Showing 2 of 5 pending candidates · llmwiki review list shows the whole queue");
    expect(html).toMatch(/href="#\/source-changes"[^>]*>Compare changed sources and proposed wiki updates</);
    expect(visible).toContain("No summary recorded.");
    expect(visible).toContain("No sources recorded → wiki/concepts/");
    expect(visible).toContain("a.md · b.md → wiki/papers/");
    expect(html).toMatch(/title="confidence 0\.4 &lt; 0\.6"[^>]*>(?:<[^>]*>)*Low confidence</);
    expect(html).toContain(">mystery<");
    expect(html).toMatch(/<strong[^>]*>beta<\/strong>/);
  });

  it("routes approval on the entity type before the directory", () => {
    expect(targetDirectoryOf(reviewCandidate({ targetDirectory: "queries", targetEntityType: "papers" }))).toBe("papers");
    expect(targetDirectoryOf(reviewCandidate({ targetDirectory: "queries" }))).toBe("queries");
    expect(targetDirectoryOf(reviewCandidate())).toBe("concepts");
  });
});

describe("source-changes model", () => {
  it("warns on refusal-grade checks, keeps source warnings, and never calls a match an approval", () => {
    const base = { id: "p", generatedAt: "", body: "", truncated: false, reasons: [] };
    expect(reviewMessage({ ...base, checks: { target: "matches", sources: "matches" } })).toContain("this is not an approval");
    expect(reviewMessage({ ...base, checks: { target: "invalid binding", sources: "changed or unavailable" } })).toBe(
      "Do not apply this proposal yet: the proposal’s saved wiki-page fingerprint is invalid. Do not apply this proposal yet: a source changed or is unavailable. Review it against the current sources.",
    );
    expect(reviewMessage({ ...base, checks: { target: "not recorded", sources: "incomplete bindings" } })).toContain("We cannot confirm it was prepared for the current wiki page.");
  });

  it("quotes the command for POSIX shells and refuses unsafe values", () => {
    expect(reviewCommand("/w/it's", "id 1")).toBe("cd -- '/w/it'\\''s' &&\nllmwiki review show -- 'id 1'");
    expect(reviewCommand("/w")).toBe("cd -- '/w' &&\nllmwiki compile --review");
    expect(reviewCommand("", "x")).toBeNull();
    expect(reviewCommand("/w", "bad\nid")).toBeNull();
  });

  it("splits only an initial frontmatter block", () => {
    expect(metadataBlock("---\na: 1\n---\nbody")).toBe("---\na: 1\n---\n");
    expect(metadataBlock("body\n---\n")).toBe("");
    expect(metadataBlock(null)).toBe("");
  });
});

describe("SourceCockpit", () => {
  it("states the bounded observation and the empty case", () => {
    const html = renderToStaticMarkup(createElement(SourceCockpit, { report: sourceChangesReport([], { stateStatus: "missing", totalPages: 3 }) }));
    expect(html).toContain("No supported affected pages or proposals found in this bounded observation.");
    expect(html).toContain("Compilation state is unavailable. No freshness conclusion can be drawn.");
    expect(html).toContain("Showing 0 of 3 pages; 0 supported proposals from 0 pending records.");
    expect(html).not.toContain("Next: ");
  });

  it("selects the first page, opens changed excerpts, and compares the first proposal", () => {
    const candidate = { id: "p1", generatedAt: "", body: "---\ntitle: New\n---\nProposed", truncated: true, checks: { target: "matches", sources: "matches" }, reasons: [] };
    const report = sourceChangesReport([sourceChangePage({ candidates: [candidate] }), sourceChangePage({ slug: "beta", title: "Beta" })], { candidateTotal: 1, candidateShown: 1 });
    const html = renderToStaticMarkup(createElement(SourceCockpit, { report }));
    expect(html).toMatch(/aria-pressed="true"[^>]*><strong[^>]*>Alpha<\/strong>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*><strong[^>]*>Beta<\/strong>/);
    expect(html).toContain("Next: review the proposed changes");
    expect(html).toContain("Proposal ID: p1");
    expect(html).toMatch(/<details\b[^>]*\bopen=""[^>]*><summary[^>]*>alpha\.md · changed<\/summary>/);
    expect(html).toContain("This proposal changes page metadata.");
    expect(html).toContain("Proposal shortened. Inspect its full body before review.");
    expect(text(html)).toContain("Without a proposal 1");
  });
});
