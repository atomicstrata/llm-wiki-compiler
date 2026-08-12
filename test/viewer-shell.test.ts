/**
 * DOM-level tests for the viewer's client script.
 *
 * Mounts `src/viewer/assets/viewer.js` into a JSDOM instance via the
 * shared `mountViewerDom` fixture (which handles ES-module rewriting
 * for JSDOM's eval). Stubs `fetch` to return fixture envelopes and
 * asserts the script renders the sidebar nav, the home dashboard,
 * and the page-rendered HTML coming back from `/api/page/...`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type PageRow,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

function pagesEnvelope(pages: PageRow[]): Record<string, unknown> {
  return {
    project: { title: "demo-wiki", rootName: "demo-wiki" },
    counts: { concepts: 1, queries: 1, sourceFiles: 0, pendingReviews: 0 },
    index: { available: false, href: "/#/index" },
    recentPages: [],
    pages,
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function pagePayload(page: PageRow, html: string): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html,
    citations: [],
    outgoingLinks: [],
    frontmatter: {},
    warnings: [],
    updatedAt: "",
    createdAt: "",
    generatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function pageAndIndexResponder(
  pages: PageRow[],
  htmlBySlug: Record<string, string> = {},
): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(pagesEnvelope(pages));
    const match = url.match(/\/api\/page\/([^/]+)\/([^/?]+)/);
    if (match) {
      const slug = decodeURIComponent(match[2]);
      const page = pages.find((p) => p.pageDirectory === match[1] && p.slug === slug);
      if (!page) return new Response(null, { status: 404 });
      return jsonResponse(pagePayload(page, htmlBySlug[slug] ?? ""));
    }
    return null;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("viewer.js — first paint + sidebar", () => {
  it("renders the sidebar nav before any fetch settles", async () => {
    const pages: PageRow[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
      { id: "queries/q1", pageDirectory: "queries", slug: "q1", title: "Q1" },
    ];
    const { dom } = await mountViewerDom(pageAndIndexResponder(pages));
    const sidebar = dom.window.document.querySelector("[data-sidebar]")!;
    // Nav structure is data-independent (renderSidebar({}) paints it before
    // /api/pages settles). The full label/route contract is pinned in
    // viewer-sidebar-nav.test.ts; this only guards that this mount path
    // reaches the real nav shell rather than the old page tree.
    expect(sidebar.textContent).toContain("BROWSE");
    expect(sidebar.textContent).toContain("MAINTAIN");
    expect(sidebar.querySelector('a[data-route="concepts"]')).not.toBeNull();
    expect(sidebar.querySelectorAll("a[data-route]").length).toBeGreaterThanOrEqual(6);
  });

  it("renders the home dashboard with project title from /api/pages", async () => {
    const pages: PageRow[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom } = await mountViewerDom(pageAndIndexResponder(pages));
    expect(dom.window.document.querySelector("[data-app-title]")!.textContent).toBe("demo-wiki");
    // The project title also reaches the dashboard's compile receipt (its
    // "Root" row reads envelope.project.rootName). The receipt now renders
    // into the shared support rail, not inside main — see viewer-rail.js
    // renderDashboardRail.
    const rail = dom.window.document.querySelector("[data-support-rail]")!;
    expect(rail.textContent).toContain("demo-wiki");
  });

  it("paints the nav shell even when the bootstrap fetch never resolves", async () => {
    // Unlike pageAndIndexResponder (which always settles quickly), this proves
    // first paint does not AWAIT /api/pages or /api/health — it only checks
    // that painting happens to finish before mountViewerDom's fixed flush
    // window, which a fetch-then-paint regression would still slip through.
    const neverResolves: FetchResponder = () => new Promise(() => {});
    const { dom } = await mountViewerDom(neverResolves);
    const sidebar = dom.window.document.querySelector("[data-sidebar]")!;
    expect(sidebar.textContent).toContain("BROWSE");
    expect(sidebar.textContent).toContain("MAINTAIN");
  });
});

describe("viewer.js — hash router", () => {
  it("renders the server-sanitized HTML returned by /api/page", async () => {
    const pages: PageRow[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const html = "<p>Body text for the <strong>alpha</strong> page.</p>";
    const { dom } = await mountViewerDom(pageAndIndexResponder(pages, { alpha: html }));
    dom.window.location.hash = "#/concepts/alpha";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("Alpha");
    expect(main.querySelector("strong")?.textContent).toBe("alpha");
    expect(main.textContent).toContain("Body text for the");
  });

  it("falls back to a generic 'No rendered content.' note when html is empty", async () => {
    const pages: PageRow[] = [
      { id: "concepts/empty", pageDirectory: "concepts", slug: "empty", title: "Empty" },
    ];
    const { dom } = await mountViewerDom(pageAndIndexResponder(pages));
    dom.window.location.hash = "#/concepts/empty";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("No rendered content.");
    expect(main.textContent).not.toContain("Slice 4");
  });
});

describe("viewer.js — malformed hash routes", () => {
  it("treats a hash with malformed percent-encoding as the home route, without throwing", async () => {
    const pages: PageRow[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom, fetchMock } = await mountViewerDom(pageAndIndexResponder(pages));
    fetchMock.mockClear();
    dom.window.location.hash = "#/concepts/%E0%A4%A";
    await flushMicrotasks();
    const fetchedPaths = fetchMock.mock.calls.map((args) => String(args[0]));
    expect(fetchedPaths.some((p) => p.includes("/api/page/"))).toBe(false);
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    // Dashboard-only copy (the hero, only built by renderDashboard) proves
    // the fallback actually reached the home route rather than merely not
    // throwing. "demo-wiki" is not used here: the project title now
    // surfaces on the home route through the compile receipt in the
    // shared support rail (see the test above), not inside main, so it is
    // no longer a route-specific signal for this element.
    expect(main.textContent).toContain("Your knowledge base is ready.");
  });
});
