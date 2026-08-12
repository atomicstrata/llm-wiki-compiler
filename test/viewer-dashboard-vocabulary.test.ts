/**
 * The Overview dashboard speaks the ACTIVE profile's vocabulary.
 *
 * On a profile project the pages live in typed directories, so `counts.concepts`
 * is 0 — and the dashboard read it anyway. A newsroom with twelve typed pages
 * showed "Concepts 0", "0 pages, 8 citations", and "All 0 concepts →" beside a
 * sidebar that correctly read Articles 6 / Desks 3 / Bylines 3. Two surfaces on
 * one screen, contradicting each other.
 *
 * Both halves are pinned here and the DEFAULT half comes first, because it is
 * the regression this change risks: a default envelope carries no
 * `profilePipeline`, and its absence must mean "behave exactly as before" —
 * the goldens below were read off the build immediately preceding this change.
 *
 * The profile figures are asserted against the SIDEBAR's own type counts rather
 * than against literals alone, since agreeing with the sidebar is the whole
 * point of the fix.
 */

import { describe, expect, it } from "vitest";
import { envelopeBootstrapResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";
import {
  typedPage,
  types,
  vocabularyEnvelope,
  type EntityType,
  type TypedPage,
} from "./fixtures/viewer-vocabulary.js";

/** Articles 6 · Desks 3 · Bylines 3 — the live newsroom project's own shape. */
const NEWSROOM = types(["articles", 6], ["desks", 3], ["bylines", 3]);

/** Three typed pages carrying 8 citations between them. */
const TYPED_PAGES = [
  typedPage("articles", "alpha", "2026-08-03T00:00:00.000Z", 4),
  typedPage("articles", "beta", "2026-08-02T00:00:00.000Z", 3),
  typedPage("desks", "city", "2026-08-01T00:00:00.000Z", 1),
];

/** One compiled concept page carrying 8 citations — the default project's own shape. */
const CONCEPT_PAGES = [typedPage("concepts", "alpha", "2026-08-02T00:00:00.000Z", 8)];

/** Counts a project of either kind reports; a profile project has no concepts. */
function counts(concepts: number): Record<string, number> {
  return { concepts, queries: 0, sourceFiles: 1, pendingReviews: 0, compiledSources: 1, stale: 0 };
}

/** Mount the home route for a project of either kind and return its document. */
async function mountHome(
  entityTypes: EntityType[] | undefined,
  pages: TypedPage[],
): Promise<Document> {
  const envelope = vocabularyEnvelope(entityTypes, pages, {
    counts: counts(entityTypes ? 0 : 7),
    graph: { nodeCount: 12, edgeCount: 20, danglingCount: 0 },
    index: { available: true, href: "/#/index" },
  });
  const { dom } = await mountViewerDom(envelopeBootstrapResponse(envelope));
  return dom.window.document;
}

/** The dashboard of a default project. */
function defaultDashboard(): Promise<Document> {
  return mountHome(undefined, CONCEPT_PAGES);
}

/** The dashboard of the newsroom profile project. */
function profileDashboard(): Promise<Document> {
  return mountHome(NEWSROOM, TYPED_PAGES);
}

/** Read one part of the first (inventory) stat card. */
function firstCard(doc: Document, part: string): string {
  return doc.querySelector(`.stat-grid .stat-card:first-child ${part}`)?.textContent ?? "";
}

/** The hero's body line — the "N pages, M citations" sentence. */
function heroBody(doc: Document): string {
  return doc.querySelector(".hero-body")?.textContent ?? "";
}

/** The recently-compiled panel's footer link ("All N …"). */
function footerLink(doc: Document): Element | null {
  return doc.querySelector(".panel:not(.graph-panel) .panel-footer a");
}

describe("a default project's dashboard is unchanged", () => {
  it("keeps the Concepts card, its key, its count and its sub-line", async () => {
    const doc = await defaultDashboard();
    expect(doc.querySelector(".stat-grid .stat-card:first-child")?.getAttribute("data-stat")).toBe(
      "concepts",
    );
    expect(firstCard(doc, ".stat-label")).toBe("Concepts");
    expect(firstCard(doc, ".stat-badge")).toBe("PAGES");
    expect(firstCard(doc, ".stat-value")).toBe("7");
    expect(firstCard(doc, ".stat-sub")).toBe("8 citations · 7 pages");
  });

  it("keeps the hero copy word for word", async () => {
    const doc = await defaultDashboard();
    expect(doc.querySelector(".hero-title")?.textContent).toBe("Your knowledge base is ready.");
    expect(heroBody(doc)).toBe("7 pages, 8 citations traced to source spans.");
  });

  it("keeps the recently-compiled links pointing at #/concepts", async () => {
    const doc = await defaultDashboard();
    expect(footerLink(doc)?.textContent).toBe("All 7 concepts →");
    expect(footerLink(doc)?.getAttribute("href")).toBe("#/concepts");
    const head = doc.querySelector(".panel:not(.graph-panel) .panel-head a");
    expect(head?.textContent).toBe("View all");
    expect(head?.getAttribute("href")).toBe("#/concepts");
  });

  it("still shows four stat cards", async () => {
    const doc = await defaultDashboard();
    expect(doc.querySelectorAll(".stat-grid .stat-card")).toHaveLength(4);
  });
});

describe("a profile project's dashboard reports its own totals", () => {
  it("labels the inventory card for what it counts, never 'Concepts'", async () => {
    const doc = await profileDashboard();
    expect(firstCard(doc, ".stat-label")).toBe("Entity pages");
    expect(firstCard(doc, ".stat-value")).toBe("12");
    expect(firstCard(doc, ".stat-sub")).toBe("8 citations · 3 types");
  });

  it("agrees with the sidebar it sits beside", async () => {
    const doc = await profileDashboard();
    const rowCounts = Array.from(doc.querySelectorAll(".nav-type-list .nav-count")).map((n) =>
      Number(n.textContent),
    );
    const sidebarTotal = rowCounts.reduce((total, count) => total + count, 0);
    expect(rowCounts).toEqual([6, 3, 3]);
    expect(firstCard(doc, ".stat-value")).toBe(String(sidebarTotal));
  });

  it("counts its own pages in the hero, not the empty concepts count", async () => {
    const doc = await profileDashboard();
    expect(heroBody(doc)).toBe("12 pages, 8 citations traced to source spans.");
  });

  it("still shows four stat cards, never one per entity type", async () => {
    const doc = await profileDashboard();
    expect(doc.querySelectorAll(".stat-grid .stat-card")).toHaveLength(4);
  });

  it("keeps the three fixed cards exactly as they are", async () => {
    const doc = await profileDashboard();
    const labels = Array.from(doc.querySelectorAll(".stat-grid .stat-label")).map(
      (n) => n.textContent,
    );
    expect(labels.slice(1)).toEqual(["Sources", "Needs attention", "Awaiting review"]);
  });
});

describe("the 'All N …' link states a true number, a true noun and a real destination", () => {
  it("names the types and points at the route that lists every one of them", async () => {
    const doc = await profileDashboard();
    expect(footerLink(doc)?.textContent).toBe("All 3 types →");
    expect(footerLink(doc)?.getAttribute("href")).toBe("#/pipeline");
  });

  it("sends 'View all' to the same real destination", async () => {
    const doc = await profileDashboard();
    const head = doc.querySelector(".panel:not(.graph-panel) .panel-head a");
    expect(head?.getAttribute("href")).toBe("#/pipeline");
  });

  it("stays singular at exactly one declared type", async () => {
    const doc = await mountHome(types(["articles", 1]), [TYPED_PAGES[0]]);
    expect(footerLink(doc)?.textContent).toBe("All 1 type →");
  });
});
