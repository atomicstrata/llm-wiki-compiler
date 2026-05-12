/**
 * DOM-level tests for the viewer's client script.
 *
 * Mounts `src/viewer/assets/viewer.js` into a JSDOM instance via the
 * shared `mountViewerDom` fixture (which handles ES-module rewriting
 * for JSDOM's eval). Stubs `fetch` to return fixture envelopes and
 * asserts the script renders the sidebar groups, the home dashboard,
 * and the page-rendered HTML coming back from `/api/page/...`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type EmbeddedPage,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

function pagesEnvelope(pages: EmbeddedPage[]): Record<string, unknown> {
  return {
    project: { title: "demo-wiki", rootName: "demo-wiki" },
    counts: { concepts: 1, queries: 1, sourceFiles: 0, pendingReviews: 0 },
    index: { available: false, href: "/#/index" },
    recentPages: [],
    pages,
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function pagePayload(page: EmbeddedPage, html: string): Record<string, unknown> {
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
  pages: EmbeddedPage[],
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
  it("renders the embedded page-index blob into sidebar groups before any fetch", async () => {
    const pages: EmbeddedPage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
      { id: "queries/q1", pageDirectory: "queries", slug: "q1", title: "Q1" },
    ];
    const { dom } = await mountViewerDom(pages, pageAndIndexResponder(pages));
    const sidebar = dom.window.document.querySelector("[data-sidebar]")!;
    expect(sidebar.textContent).toContain("Concepts");
    expect(sidebar.textContent).toContain("Alpha");
    expect(sidebar.textContent).toContain("Saved Queries");
    expect(sidebar.textContent).toContain("Q1");
  });

  it("renders the home dashboard with project title from /api/pages", async () => {
    const pages: EmbeddedPage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom } = await mountViewerDom(pages, pageAndIndexResponder(pages));
    expect(dom.window.document.querySelector("[data-app-title]")!.textContent).toBe("demo-wiki");
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("demo-wiki");
  });
});

describe("viewer.js — hash router", () => {
  it("renders the server-sanitized HTML returned by /api/page", async () => {
    const pages: EmbeddedPage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const html = "<p>Body text for the <strong>alpha</strong> page.</p>";
    const { dom } = await mountViewerDom(
      pages,
      pageAndIndexResponder(pages, { alpha: html }),
    );
    dom.window.location.hash = "#/concepts/alpha";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("Alpha");
    expect(main.querySelector("strong")?.textContent).toBe("alpha");
    expect(main.textContent).toContain("Body text for the");
  });

  it("falls back to a generic 'No rendered content.' note when html is empty", async () => {
    const pages: EmbeddedPage[] = [
      { id: "concepts/empty", pageDirectory: "concepts", slug: "empty", title: "Empty" },
    ];
    const { dom } = await mountViewerDom(pages, pageAndIndexResponder(pages));
    dom.window.location.hash = "#/concepts/empty";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("No rendered content.");
    expect(main.textContent).not.toContain("Slice 4");
  });
});

describe("viewer.js — malformed hash routes", () => {
  it("treats a hash with malformed percent-encoding as the home route, without throwing", async () => {
    const pages: EmbeddedPage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom, fetchMock } = await mountViewerDom(pages, pageAndIndexResponder(pages));
    fetchMock.mockClear();
    dom.window.location.hash = "#/concepts/%E0%A4%A";
    await flushMicrotasks();
    const fetchedPaths = fetchMock.mock.calls.map((args) => String(args[0]));
    expect(fetchedPaths.some((p) => p.includes("/api/page/"))).toBe(false);
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("demo-wiki");
  });
});
