/**
 * DOM-level tests for the `#/health` route's right-hand column: the profile
 * problems panel, the Freshness panel, the Traceability meter, and the cache
 * note.
 *
 * Every panel here projects `/api/pages` rather than `/api/health` — freshness
 * is per-page (one bar each, coloured by that page's own status), traceability
 * is the citation totals summed across pages, and the collector's problems ride
 * the same snapshot envelope — so these tests drive the page rows and the
 * envelope's profile fields, not the health counts.
 */

import { describe, expect, it } from "vitest";
import {
  conceptPage,
  pagesEnvelope,
  renderHealthRoute,
  textOf,
  type Payload,
} from "./fixtures/viewer-health-fixture.js";

/** A health payload with a clean lint cache, so only the page rows vary. */
const CLEAN: Payload = { concepts: 3, queries: 0, sourceFiles: 1, sources: 1, lint: null };

/** Render the health route over a given set of page rows. */
function withPages(pages: Payload[], health: Payload = CLEAN): Promise<HTMLElement> {
  return renderHealthRoute(health, pagesEnvelope(pages));
}

/** Read the freshness bars' state modifier classes, in render order. */
function barClasses(main: HTMLElement): string[] {
  return [...main.querySelectorAll(".freshness-bar")].map((n) => n.className.replace("freshness-bar ", ""));
}

describe("freshness panel — one bar per concept page", () => {
  it("renders exactly one bar per concept page and ignores query pages", async () => {
    const main = await withPages([
      conceptPage("alpha"),
      conceptPage("beta"),
      { ...conceptPage("q"), pageDirectory: "queries" },
    ]);
    expect(main.querySelectorAll(".freshness-bar")).toHaveLength(2);
  });

  it("colours each bar by that page's own freshness status", async () => {
    const main = await withPages([
      conceptPage("a"),
      conceptPage("b", { freshness: { freshnessStatus: "stale" } }),
      conceptPage("c", { freshness: { freshnessStatus: "orphaned" } }),
      conceptPage("d", { freshness: {} }),
    ]);
    expect(barClasses(main)).toEqual(["is-fresh", "is-stale", "is-orphaned", "is-unverified"]);
  });

  it("badges IN SYNC when nothing is stale or orphaned", async () => {
    const main = await withPages([conceptPage("a"), conceptPage("b")]);
    const badge = main.querySelector("[data-freshness-panel] .freshness-pill");
    expect(badge?.className).toContain("is-ok");
    expect(badge?.textContent).toBe("IN SYNC");
    expect(textOf(main, ".freshness-note")).toContain("Every page is newer than its sources");
  });

  it("badges the stale and orphaned counts and says so in the note", async () => {
    const main = await withPages([
      conceptPage("a", { freshness: { freshnessStatus: "stale" } }),
      conceptPage("b", { freshness: { freshnessStatus: "orphaned" } }),
    ]);
    const badge = main.querySelector("[data-freshness-panel] .freshness-pill");
    expect(badge?.className).toContain("is-warn");
    expect(badge?.textContent).toBe("1 STALE · 1 ORPHANED");
    expect(textOf(main, ".freshness-note")).toBe("1 page stale and 1 page orphaned out of 2.");
  });

  it("refuses to claim IN SYNC when no page's freshness could be computed", async () => {
    const main = await withPages([conceptPage("a", { freshness: {} }), conceptPage("b", { freshness: {} })]);
    const badge = main.querySelector("[data-freshness-panel] .freshness-pill");
    expect(badge?.className).toContain("is-unknown");
    expect(badge?.textContent).toBe("UNVERIFIED");
    expect(textOf(main, ".freshness-note")).toContain("could not be checked for any page");
  });

  it("names how many pages went unchecked when only some did", async () => {
    const main = await withPages([conceptPage("a"), conceptPage("b", { freshness: {} })]);
    expect(main.querySelector("[data-freshness-panel] .freshness-pill")?.textContent).toBe("IN SYNC");
    expect(textOf(main, ".freshness-note")).toContain("could not be checked for 1 page");
  });

  it("says the wiki is empty rather than drawing an empty bar row", async () => {
    const main = await withPages([]);
    expect(main.querySelectorAll(".freshness-bar")).toHaveLength(0);
    expect(textOf(main, ".freshness-note")).toBe("No concept pages yet.");
  });
});

describe("traceability panel — cited citations as a share of all citations", () => {
  it("renders the resolved percentage, the n / m figure and a two-segment bar", async () => {
    const main = await withPages([
      conceptPage("a", { citationCount: 8, unresolvedCitationCount: 2 }),
      conceptPage("b", { citationCount: 2, unresolvedCitationCount: 0 }),
    ]);
    expect(textOf(main, ".trace-value")).toBe("80%");
    expect(textOf(main, ".trace-detail")).toBe("8 / 10 citations");
    expect((main.querySelector("[data-traceability-panel] .bar-fill") as HTMLElement).style.width).toBe("80%");
  });

  it("names how many citations still resolve to nothing", async () => {
    const main = await withPages([conceptPage("a", { citationCount: 4, unresolvedCitationCount: 1 })]);
    expect(textOf(main, ".trace-note")).toContain("1 citation still points at no source file");
  });

  it("reports a fully traced wiki without a shortfall sentence", async () => {
    const main = await withPages([conceptPage("a", { citationCount: 3, unresolvedCitationCount: 0 })]);
    expect(textOf(main, ".trace-value")).toBe("100%");
    expect(textOf(main, ".trace-note")).toBe("Every citation resolves to a real source span.");
  });

  it("does not divide by zero when nothing has been cited yet", async () => {
    const main = await withPages([conceptPage("a", { citationCount: 0, unresolvedCitationCount: 0 })]);
    expect(textOf(main, ".trace-value")).toBe("100%");
    expect(textOf(main, ".trace-detail")).toBe("0 / 0 citations");
    expect(textOf(main, ".trace-note")).toBe("No citations recorded yet.");
  });
});

/** One collector problem, in the shape `/api/pages` serialises it. */
function problem(overrides: Payload = {}): Payload {
  return {
    kind: "field-violation",
    entityType: "notes",
    path: "wiki/notes/a.md",
    message: 'missing required field "title"',
    ...overrides,
  };
}

/** Render the health route over an envelope reporting `problems` out of `total`. */
function withProblems(problems: Payload[], total = problems.length): Promise<HTMLElement> {
  const overrides = { profileProblems: problems, profileProblemTotal: total };
  return renderHealthRoute(CLEAN, pagesEnvelope([], overrides));
}

/** Read every problem row's trimmed text, in render order. */
function rowTexts(main: HTMLElement): string[] {
  return [...main.querySelectorAll(".profile-problem")].map((n) => n.textContent?.trim() ?? "");
}

describe("profile problems panel — what the collector found, and where", () => {
  it("stays absent for a project the collector found nothing wrong with", async () => {
    const main = await withPages([conceptPage("a")]);
    expect(main.querySelector("[data-profile-panel]")).toBeNull();
  });

  it("renders one row per problem, naming what is wrong and where", async () => {
    const main = await withProblems([problem(), problem({ path: "wiki/notes/b.md" })]);
    expect(rowTexts(main)).toHaveLength(2);
    expect(textOf(main, ".profile-problem-kind")).toBe("Missing or invalid information");
    expect(textOf(main, ".profile-problem-where")).toBe("wiki/notes/a.md");
    expect(textOf(main, ".profile-problem-message")).toContain('missing required field "title"');
  });

  it("badges the problem count so the panel head states the scale", async () => {
    const main = await withProblems([problem(), problem(), problem()]);
    const badge = main.querySelector("[data-profile-panel] .freshness-pill");
    expect(badge?.textContent).toBe("3 PROBLEMS");
    expect(badge?.className).toContain("is-warn");
  });

  it("falls back to the entity type when a directory-level problem names no page", async () => {
    const dirProblem = { kind: "invalid-directory", entityType: "notes", message: "not a directory" };
    const main = await withProblems([dirProblem]);
    expect(textOf(main, ".profile-problem-where")).toBe("notes");
  });

  it("says how many of how many when the list was capped", async () => {
    const main = await withProblems([problem(), problem()], 253);
    expect(rowTexts(main)).toHaveLength(2);
    expect(textOf(main, ".profile-footer")).toBe("Showing 2 of 253 problems.");
  });

  it("shows no such notice when the list is the whole set", async () => {
    const main = await withProblems([problem(), problem()]);
    expect(main.querySelector(".profile-footer")).toBeNull();
  });
});

describe("health screen — cache note and pane sizing", () => {
  it("explains that lint results are cached and names the refresh command", async () => {
    const main = await withPages([conceptPage("a")]);
    const note = textOf(main, ".cache-note");
    expect(note).toContain("cached from the last run");
    expect(textOf(main, ".cache-note code")).toBe("llmwiki lint");
  });

  it("asks for a reload, never a restart — the lint cache is re-read per request", async () => {
    const main = await withPages([conceptPage("a")]);
    const note = textOf(main, ".cache-note");
    expect(note).toContain("reload");
    expect(note).not.toContain("restart");
  });

  it("opts the pane out of the prose-width cap so the two-column grid can breathe", async () => {
    const main = await withPages([conceptPage("a")]);
    expect(main.className).toContain("health-pane");
    expect(main.querySelector(".health-grid")).not.toBeNull();
  });
});
