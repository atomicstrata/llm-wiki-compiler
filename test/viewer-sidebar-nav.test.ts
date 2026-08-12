/**
 * Sidebar navigation contract.
 *
 * The Nebula sidebar is pure navigation with counts — the page tree and the
 * freshness filter live on #/concepts. These tests pin the nav entries, the
 * count rendering rules (a zero BROWSE count renders as an em dash — nothing
 * to browse; a zero MAINTAIN count renders as the literal digit — a
 * meaningful, reassuring "0", not an absence — and an unrun lint omits its
 * badge entirely), and active-route marking including page routes marking
 * their parent nav entry.
 *
 * The nav-integrity test at the bottom is the load-bearing one. It replaces a
 * test called "links each nav entry to its route" that never read a single
 * `href`: it collected `data-route` values and checked membership with
 * `arrayContaining`, so an entry pointing at a dead hash passed, and it did —
 * for the entire life of the bug where "Reviews" pointed at `#/health` and
 * highlighted "Health & lint". The replacement NAVIGATES to each entry's own
 * href and asserts the entry that lights up is that same entry, and it derives
 * the entry list from the rendered DOM so a nav entry added later is covered
 * without joining a list.
 */

import { describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const ENVELOPE = {
  project: { title: "my-llm-wiki", rootName: "my-llm-wiki" },
  stateStatus: "ok",
  profileId: "default",
  counts: {
    concepts: 7, queries: 0, sourceFiles: 1, pendingReviews: 0,
    compiledSources: 1, stale: 0, orphaned: 0,
  },
  graph: { nodeCount: 12, edgeCount: 20, danglingCount: 11 },
  sourceFilenames: ["karpathy.md"],
  index: { available: true, href: "/#/index" },
  recentPages: [],
  pages: [],
};

/**
 * Responder serving the envelope plus a health payload with the given lint
 * block. `/api/reviews` and `/api/workflow-runs` are served too — they are the
 * nav destinations that fetch per visit, and a 404 on either would paint an
 * error banner that the nav-integrity test below could mistake for a rendered
 * route.
 */
function responderWithLint(lint: unknown): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(ENVELOPE);
    if (url.endsWith("/api/health")) return jsonResponse({ lint });
    if (url.endsWith("/api/reviews")) return jsonResponse({ reviews: [], total: 0 });
    if (url.endsWith("/api/workflow-runs")) return jsonResponse({ runs: [] });
    return null;
  };
}

/** Mount and return the sidebar element. */
async function mountSidebar(lint: unknown, startHash?: string): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(responderWithLint(lint), startHash);
  return dom.window.document.querySelector(".sidebar") as HTMLElement;
}

describe("sidebar navigation", () => {
  it("renders the BROWSE and MAINTAIN sections", async () => {
    const sidebar = await mountSidebar(null);
    const labels = Array.from(sidebar.querySelectorAll(".nav-section-label")).map(
      (n) => n.textContent,
    );
    expect(labels).toContain("BROWSE");
    expect(labels).toContain("MAINTAIN");
  });

  it("renders the project title and read-only marker", async () => {
    const sidebar = await mountSidebar(null);
    expect(sidebar.querySelector("[data-project-name]")?.textContent).toBe("my-llm-wiki");
    expect(sidebar.textContent).toContain("LOCAL · READ ONLY");
  });

  it("renders a zero BROWSE count (Queries) as an em dash", async () => {
    const sidebar = await mountSidebar(null);
    const queries = sidebar.querySelector('a[data-route="queries"] .nav-count');
    expect(queries?.textContent).toBe("—");
  });

  it("renders a zero MAINTAIN count (Reviews) as the literal digit, not an em dash", async () => {
    // "Zero pending reviews" is a meaningful, reassuring fact, unlike
    // "nothing to browse" — see NAV_SECTIONS' zeroCountDisplay.
    const sidebar = await mountSidebar(null);
    const reviews = sidebar.querySelector('a[data-route="reviews"] .nav-count');
    expect(reviews?.textContent).toBe("0");
  });

  it("marks a zero count with the nav-count-zero modifier (--fg-disabled), in both sections", async () => {
    const sidebar = await mountSidebar(null);
    const queries = sidebar.querySelector('a[data-route="queries"] .nav-count');
    const reviews = sidebar.querySelector('a[data-route="reviews"] .nav-count');
    expect(queries?.className).toContain("nav-count-zero");
    expect(reviews?.className).toContain("nav-count-zero");
  });

  it("renders a non-zero count as its number", async () => {
    const sidebar = await mountSidebar(null);
    expect(sidebar.querySelector('a[data-route="concepts"] .nav-count')?.textContent).toBe("7");
  });

  it("does not mark a non-zero count with the nav-count-zero modifier", async () => {
    const sidebar = await mountSidebar(null);
    const concepts = sidebar.querySelector('a[data-route="concepts"] .nav-count');
    expect(concepts?.className).not.toContain("nav-count-zero");
  });

  it("gives PROJECT its own label class, distinct from BROWSE/MAINTAIN", async () => {
    const sidebar = await mountSidebar(null);
    expect(sidebar.querySelector(".project-label")?.textContent).toBe("PROJECT");
    expect(sidebar.querySelectorAll(".nav-section-label")).toHaveLength(2);
  });

  it("omits the lint badge entirely when lint has never run", async () => {
    const sidebar = await mountSidebar(null);
    expect(sidebar.querySelector('a[data-route="health"] .nav-badge')).toBeNull();
  });

  it("sums warnings and errors into the lint badge", async () => {
    const sidebar = await mountSidebar({ warnings: 9, errors: 2, at: "2026-08-01T00:00:00.000Z" });
    expect(sidebar.querySelector('a[data-route="health"] .nav-badge')?.textContent).toBe("11");
  });

  it("marks a page route's parent nav entry as current", async () => {
    const sidebar = await mountSidebar(null, "#/concepts/alpha");
    const concepts = sidebar.querySelector('a[data-route="concepts"]');
    expect(concepts?.getAttribute("aria-current")).toBe("page");
  });

  it("does not render Settings or Compile & export", async () => {
    const sidebar = await mountSidebar(null);
    expect(sidebar.textContent).not.toContain("Settings");
    expect(sidebar.textContent).not.toContain("Compile & export");
  });
});

/** One nav entry as the sidebar actually rendered it. */
interface NavEntry {
  route: string;
  href: string;
}

/** Every nav entry the sidebar renders, read from the DOM rather than a fixed list. */
async function renderedNavEntries(): Promise<NavEntry[]> {
  const sidebar = await mountSidebar(null);
  return Array.from(sidebar.querySelectorAll("a[data-route]")).map((a) => ({
    route: a.getAttribute("data-route") ?? "",
    href: a.getAttribute("href") ?? "",
  }));
}

/** Mount at `href` and report what the main pane and the sidebar did with it. */
async function visitHref(href: string): Promise<{ painted: boolean; current: string | null }> {
  const { dom } = await mountViewerDom(responderWithLint(null), href);
  const doc = dom.window.document;
  const main = doc.querySelector("[data-main-pane]") as HTMLElement;
  const current = doc.querySelector('.sidebar a[aria-current="page"]');
  return { painted: isPanePainted(main), current: current?.getAttribute("data-route") ?? null };
}

/**
 * Evidence the router painted this route rather than leaving the pane as the
 * router found it: rendered children, or the route-specific pane class the
 * renderer claims before drawing. `#/graph` needs that second half — D3 is
 * stubbed under JSDOM (see fixtures/viewer-jsdom.ts), so the graph route
 * legitimately draws no DOM here while still setting `graph-pane`. A route
 * nothing handles leaves a bare, empty `main-pane`.
 */
function isPanePainted(main: HTMLElement): boolean {
  return main.childElementCount > 0 || main.className !== "main-pane";
}

describe("sidebar navigation — every rendered entry resolves to its own route", () => {
  // The router falls back to home for an unknown hash (viewer.js), so
  // "something rendered" cannot tell a real route from a dead href — a dead
  // href renders the dashboard and looks fine. The aria-current assertion is
  // what separates them, and it is exactly what the Reviews bug broke.
  it("navigating an entry's own href renders a route and marks that same entry current", async () => {
    const entries = await renderedNavEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const { painted, current } = await visitHref(entry.href);
      expect(painted, `${entry.href} (${entry.route}) rendered nothing`).toBe(true);
      expect(current, `${entry.href} did not mark the ${entry.route} entry current`).toBe(
        entry.route,
      );
    }
  });
});
