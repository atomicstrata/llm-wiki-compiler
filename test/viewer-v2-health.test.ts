/**
 * The v2 health screen: its pure derivations (lint caption, contents
 * columns, lint rows and footer, freshness, traceability, record problems)
 * and the screen rendered to static markup in its never-linted and
 * populated states.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  contentsColumns, countFigure, freshnessSummary, lintFooter, lintRuleRows, lintRunCaption, problemsSummary, traceability,
} from "../viewer-v2/src/health-model.js";
import { HealthView } from "../viewer-v2/src/health-view.js";
import { envelope, healthWith, lintRule, page, text } from "./fixtures/viewer-v2-fixtures.js";

const NOW = new Date("2026-11-10T14:00:00.000Z");
const PAGES = new Set(["concepts/alpha", "queries/q"]);

describe("lintRunCaption and the contents strip", () => {
  it("says never run, or when and how long ago, dropping the age when unparseable", () => {
    expect(lintRunCaption(null, NOW)).toBe("Lint has never run");
    expect(lintRunCaption({ warnings: 0, errors: 0, at: "2026-11-10T12:00:00.000Z" }, NOW)).toBe("Lint last run 2026-11-10 12:00Z · 2 h ago");
    expect(lintRunCaption({ warnings: 0, errors: 0, at: "" }, NOW)).toBe("Lint last run at an unknown time");
  });

  it("fills five columns from health counts and the envelope's citations, writing zero as a dash", () => {
    const health = healthWith(null, { concepts: 2, sourceFiles: 3, sources: 1, queries: 0, pendingReviews: 4 });
    const wiki = envelope({ pages: [page({ citationCount: 5, unresolvedCitationCount: 2 })] });
    const columns = contentsColumns(health, wiki);
    expect(columns.map((column) => [column.value, column.suffix])).toEqual([
      [2, "pages"], [3, "1 compiled"], [5, "3 cited"], [0, "none yet"], [4, "candidates"],
    ]);
    expect(contentsColumns(null, envelope()).every((column) => column.value === 0)).toBe(true);
    expect(countFigure(0)).toBe("—");
    expect(countFigure(7)).toBe("7");
  });
});

describe("lint rows and footer", () => {
  it("names the top four rules, folds the rest, and links only routable pages", () => {
    const rules = [
      lintRule({ rule: "a", count: 9, fileCount: 3, topFileCount: 5 }),
      lintRule({ rule: "b", count: 4, fileCount: 4, topFileCount: 1, topFile: "wiki/concepts/missing.md" }),
      lintRule({ rule: "c", count: 2, topFile: ".llmwiki/journal.json" }),
      lintRule({ rule: "d", count: 1 }),
      lintRule({ rule: "e", count: 1 }),
      lintRule({ rule: "f", count: 1 }),
    ];
    const rows = lintRuleRows(rules, PAGES);
    expect(rows.map((row) => [row.rule, row.count, row.affected, row.href])).toEqual([
      ["a", 9, "alpha · 5 of 9", "#/concepts/alpha"],
      ["b", 4, "4 files", null],
      ["c", 2, "journal.json", null],
      ["d", 1, "alpha", "#/concepts/alpha"],
      ["other", 2, "2 rules", null],
    ]);
  });

  it("sends link-graph rules to the explorer and others to their page, and is absent on a clean run", () => {
    expect(lintFooter([lintRule({ count: 3 })], 4, PAGES)).toEqual({
      insight: "3 of 4 problems come from broken-wikilink.", action: { href: "#/graph", label: "Open the graph explorer" },
    });
    expect(lintFooter([lintRule({ rule: "missing-citation", count: 2 })], 2, PAGES)?.action).toEqual({ href: "#/concepts/alpha", label: "Open alpha" });
    expect(lintFooter([lintRule({ rule: "journal-health", topFile: "x.json", count: 1 })], 1, PAGES)?.action).toBeNull();
    expect(lintFooter([], 0, PAGES)).toBeNull();
  });
});

describe("freshness, traceability and record problems", () => {
  it("badges the actionable counts, or UNVERIFIED when nothing could be checked", () => {
    const stale = page({ id: "concepts/s", freshness: { freshnessStatus: "stale", contradicted: false, archived: false } });
    const unverified = page({ id: "concepts/u", freshness: { freshnessStatus: "unverified", contradicted: false, archived: false } });
    expect(freshnessSummary([])).toEqual({ badge: { text: "IN SYNC", tone: "ok" }, note: "No concept pages yet." });
    expect(freshnessSummary([page(), stale]).badge).toEqual({ text: "1 STALE", tone: "warn" });
    expect(freshnessSummary([page(), stale]).note).toBe("1 page stale and 0 pages orphaned out of 2.");
    expect(freshnessSummary([unverified]).badge).toEqual({ text: "UNVERIFIED", tone: "unknown" });
    expect(freshnessSummary([page(), unverified]).note).toContain("Freshness could not be checked for 1 page — state.json");
    expect(freshnessSummary([page()]).note).toBe("Every page is newer than its sources. Nothing stale, nothing orphaned.");
  });

  it("counts an empty wiki as fully traced and names the unresolved citations", () => {
    expect(traceability([])).toEqual({ percent: 100, detail: "0 / 0 citations", note: "No citations recorded yet." });
    expect(traceability([page({ citationCount: 3, unresolvedCitationCount: 1 })])).toEqual({
      percent: 67, detail: "2 / 3 citations", note: "1 citation still points at no source file — the rest resolve to a real span.",
    });
  });

  it("labels problem kinds, places them, and says when the wire list was capped", () => {
    const wiki = envelope({
      profileId: "autosci",
      profileProblems: [{ kind: "field-violation", entityType: "papers", path: "wiki/papers/a.md", message: "title is required" }, { kind: "invalid-directory", entityType: "papers", message: "missing" }],
      profileProblemTotal: 5,
    });
    const summary = problemsSummary(wiki);
    expect(summary.rows.map((row) => [row.label, row.where])).toEqual([["Missing or invalid information", "wiki/papers/a.md"], ["Invalid directory", "papers"]]);
    expect(summary.notice).toBe("Showing 2 of 5 problems.");
    expect(problemsSummary(envelope())).toEqual({ rows: [], total: 0, notice: null });
  });
});

describe("HealthView", () => {
  it("renders the never-run placeholder and dashes on an empty wiki", () => {
    const html = renderToStaticMarkup(createElement(HealthView, { wiki: envelope(), health: null }));
    expect(html).toContain("Lint has never run");
    expect(html).toContain("No cached lint summary yet");
    expect(html).toContain('data-contents="reviews"');
    expect(html).not.toContain("Record problems");
    expect(html.match(/data-contents="/g)?.length).toBe(5);
    expect(html.match(/>—</g)?.length).toBe(5);
  });

  it("renders the lint table with a page link, the freshness badge, and the record problems", () => {
    const health = healthWith({ warnings: 3, errors: 1, at: "2026-11-10T12:00:00.000Z", rules: [lintRule({ count: 4, severity: "error" })] }, { concepts: 1 });
    const wiki = envelope({ pages: [page({ citationCount: 2 })], profileProblems: [{ kind: "slug-mismatch", path: "wiki/papers/b.md", message: "slug differs" }] });
    const html = renderToStaticMarkup(createElement(HealthView, { wiki, health }));
    expect(html).toContain("4 PROBLEMS");
    expect(html).toMatch(/<td[^>]*><a href="#\/concepts\/alpha"[^>]*>view →<\/a><\/td>/);
    expect(html).toContain("4 of 4 problems come from broken-wikilink.");
    expect(text(html)).toContain("Freshness IN SYNC");
    expect(html).toContain("1 PROBLEM<");
    expect(html).toContain("Slug mismatch");
    expect(html).toContain("2 / 2 citations");
  });
});
