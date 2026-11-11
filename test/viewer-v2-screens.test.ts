/**
 * The v2 viewer's screens, rendered to static markup against fixture
 * payloads: the sidebar's counts and active row, the dashboard's order,
 * cards and hints, page rows with their summaries, the recency screen's
 * groups and badge, and the search helpers.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "../viewer-v2/src/dashboard.js";
import { matchesTitle, PageRowItem } from "../viewer-v2/src/lists.js";
import { activeNavRoute, Sidebar } from "../viewer-v2/src/nav.js";
import { isNewPage, RecentView } from "../viewer-v2/src/recent-view.js";
import { parseRoute } from "../viewer-v2/src/route.js";
import { plainSnippet, resultKind } from "../viewer-v2/src/search.js";
import { envelope, healthWith, page, text } from "./fixtures/viewer-v2-fixtures.js";

const WIKI = envelope({
  counts: { concepts: 2, queries: 0, sourceFiles: 3, pendingReviews: 0, compiledSources: 3, stale: 1, orphaned: 0 },
  graph: { nodeCount: 2, edgeCount: 1, danglingCount: 2 },
  pages: [
    page({ id: "concepts/alpha", citationCount: 3, unresolvedCitationCount: 1 }),
    page({ id: "concepts/beta", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-10T12:00:00.000Z" }),
  ],
  recentPages: [{ id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha", updatedAt: "2026-11-10T12:00:00.000Z" }],
});

describe("Sidebar", () => {
  it("writes zero as a dash under Browse and a digit under Maintain, and lights the active row", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { wiki: WIKI, health: null, route: parseRoute("#/concepts/alpha") }));
    expect(html).toContain('data-route="queries"');
    expect(html).toContain("—");
    // Asserted on structure and text, not utility classes, so restyling cannot break it.
    expect(text(html.match(/<a[^>]*data-route="reviews"[\s\S]*?<\/a>/)![0])).toBe("Reviews 0");
    expect(html).toContain('data-route="concepts" aria-current="page"');
    expect(html).not.toContain("Workflows");
  });

  it("leads with the reading rows, and offers the overview only when the wiki has an index", () => {
    const firstRows = (available: boolean) => {
      const html = renderToStaticMarkup(createElement(Sidebar, { wiki: { ...WIKI, index: { available } }, health: null, route: parseRoute("#/") }));
      return [...html.matchAll(/data-route="(\w+)"/g)].slice(0, 3).map((match) => match[1]);
    };
    expect(firstRows(true)).toEqual(["home", "index", "timeline"]);
    expect(firstRows(false)).toEqual(["home", "timeline", "concepts"]);
  });

  it("maps every route to the row it lights", () => {
    expect(activeNavRoute(parseRoute("#/index"))).toBe("index");
    expect(activeNavRoute(parseRoute("#/recent"))).toBe("recent");
    expect(activeNavRoute(parseRoute("#/timeline"))).toBe("timeline");
    expect(activeNavRoute(parseRoute("#/timeline/2026-05-04"))).toBe("timeline");
    expect(activeNavRoute(parseRoute("#/_type/papers"))).toBe("papers");
    expect(activeNavRoute(parseRoute("#/source-changes"))).toBe("reviews");
    expect(activeNavRoute(parseRoute("#/_search?q=x"))).toBeNull();
  });
});

describe("Dashboard", () => {
  it("derives the cards, the hero, and the applicable next actions", () => {
    const html = renderToStaticMarkup(createElement(Dashboard, { wiki: WIKI, health: healthWith(null) }));
    expect(html).toContain("2 broken page links · 1 unresolved citation");
    expect(html).toContain("2 pages, 3 citations traced to source spans.");
    expect(html).toContain("Resolve 2 dangling links");
    expect(html).toContain("Recompile 1 stale page");
    expect(html).toContain("Run lint");
    expect(html).toMatch(/href="#\/recent"[^>]*>View all/);
    expect(html).toContain("67%");
  });

  it("leads with the pages and puts the numbers after them", () => {
    const html = renderToStaticMarkup(createElement(Dashboard, { wiki: WIKI, health: null }));
    expect(html.indexOf("Recently compiled")).toBeGreaterThan(-1);
    expect(html.indexOf("Recently compiled")).toBeLessThan(html.indexOf("data-stat="));
  });
});

describe("PageRowItem", () => {
  const now = new Date("2026-11-10T13:00:00.000Z");
  const row = (summary: string) => renderToStaticMarkup(createElement("ul", null, createElement(PageRowItem, { page: page({ summary }), now })));

  it("shows the summary under the title, and no empty line when there is none", () => {
    expect(text(row("Cone 6 firing schedule."))).toStartWith("Alpha Cone 6 firing schedule. ");
    expect(row("Cone 6 firing schedule.")).toContain('title="Cone 6 firing schedule."');
    // A blank summary leaves the title alone in its column: no empty second line.
    expect(row("  ")).toContain(">Alpha</span></span>");
  });
});

describe("RecentView and search helpers", () => {
  it("marks only pages whose last write created them", () => {
    expect(isNewPage(WIKI.pages[0])).toBe(true);
    expect(isNewPage(WIKI.pages[1])).toBe(false);
    const html = renderToStaticMarkup(createElement(RecentView, { wiki: WIKI }));
    expect(html).toContain("2 pages, newest first");
    expect(html.match(/>new<\/span>/g)?.length).toBe(1);
  });

  it("filters titles by every word and labels hits by kind", () => {
    expect(matchesTitle(WIKI.pages, "al").map((row) => row.id)).toEqual(["concepts/alpha"]);
    expect(resultKind({ id: "queries/q", pageDirectory: "queries", title: "", snippet: "", matchedIn: "title" })).toBe("query");
    expect(resultKind({ id: "timeline/2026-05-04", pageDirectory: "timeline", title: "", snippet: "", matchedIn: "body" })).toBe("timeline");
    expect(plainSnippet("see [[a|b]] and [[c]]")).toBe("see b and c");
  });
});
