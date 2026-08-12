/**
 * Client hash-routing for a profile's typed entity pages.
 *
 * `/api/page/:directory/:slug` serves a profile's entity types, and search
 * returns typed rows linking to `#/<entityType>/<slug>`. The hash router used to
 * enumerate `(concepts|queries)`, so every one of those links fell through to
 * home — a dead link that looked like a working one, the same class of defect as
 * the nav entry that highlighted the wrong row.
 *
 * These tests pin the two halves that keep it honest: a typed hash reaches
 * `/api/page`, and a directory the server rejects renders "not found" rather
 * than silently showing the dashboard.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

const ENVELOPE = {
  project: { title: "newsroom", rootName: "newsroom" },
  profileId: "newsroom",
  counts: {},
  pages: [],
  recentPages: [],
  index: { available: false },
};

/** Serves one typed page; any other `/api/page` path 400s the way the real allowlist does. */
const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) return jsonResponse(ENVELOPE);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  if (url.includes("/api/page/articles/harbour-lease-records")) {
    return jsonResponse({
      pageDirectory: "articles",
      slug: "harbour-lease-records",
      title: "Harbour lease records",
      html: "<p>Released on 3 August.</p>",
      warnings: [],
    });
  }
  if (url.includes("/api/page/")) {
    return new Response(JSON.stringify({ code: "bad_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
};

afterEach(() => vi.restoreAllMocks());

describe("typed entity page routing", () => {
  it("routes a profile entity-type hash to the page pane, not home", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.location.hash = "#/articles/harbour-lease-records";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.querySelector("h1")?.textContent).toBe("Harbour lease records");
    expect(main.textContent).toContain("Released on 3 August.");
  });

  it("does not render the dashboard for a typed page hash", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.location.hash = "#/articles/harbour-lease-records";
    await flushMicrotasks();
    // The dashboard's stat grid is the tell: before the fix the hash fell
    // through to home and this rendered instead of the page.
    expect(dom.window.document.querySelector(".stat-grid")).toBeNull();
  });

  it("renders not-found for a directory the server rejects", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.location.hash = "#/not-a-type/whatever";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.querySelector(".placeholder")?.textContent).toContain("Page not found");
    expect(dom.window.document.querySelector(".stat-grid")).toBeNull();
  });

  it("still falls back to home for a single-segment unknown hash", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.location.hash = "#/nonsense";
    await flushMicrotasks();
    // Single-segment hashes never reach the page pattern, so the nav-integrity
    // test's home-fallback assumption (viewer-sidebar-nav.test.ts) still holds.
    expect(dom.window.document.querySelector(".stat-grid")).toBeTruthy();
  });
});
