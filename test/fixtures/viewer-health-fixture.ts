/**
 * Shared JSDOM fixture for the `#/health` route's DOM-level tests.
 *
 * The health screen reads BOTH bootstrap payloads — `/api/health` for the
 * counts and the lint cache, `/api/pages` for per-page freshness and
 * citation totals — so every test here needs a responder that serves the
 * two together. That responder, the mount-and-navigate dance, and the page
 * row builders live here rather than being copied into each of the three
 * health test files (dashboard / panels / lint), which is what the split
 * into three files would otherwise cost.
 */

import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./viewer-jsdom.js";

/** Loose payload shape: tests deliberately serve partial envelopes. */
export type Payload = Record<string, unknown>;

/** Serve `/api/health` and `/api/pages` from two literal payloads. */
export function healthResponder(health: Payload, pages: Payload): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(pages);
    if (url.endsWith("/api/health")) return jsonResponse(health);
    return null;
  };
}

/**
 * Build one `/api/pages` row. Defaults describe a healthy, fully cited
 * concept page so a test only states the field it is actually exercising.
 */
export function conceptPage(slug: string, overrides: Payload = {}): Payload {
  return {
    id: `concepts/${slug}`,
    pageDirectory: "concepts",
    slug,
    title: slug,
    updatedAt: "2026-08-05T12:00:00.000Z",
    freshness: { freshnessStatus: "fresh" },
    citationCount: 1,
    unresolvedCitationCount: 0,
    ...overrides,
  };
}

/** Wrap page rows in the minimal `/api/pages` envelope the viewer bootstraps from. */
export function pagesEnvelope(pages: Payload[] = [], overrides: Payload = {}): Payload {
  return {
    project: { title: "demo" },
    counts: {},
    pages,
    recentPages: [],
    index: { available: false },
    graph: { nodeCount: pages.length, edgeCount: 0, danglingCount: 0 },
    ...overrides,
  };
}

/** Mount the viewer, navigate to `#/health`, and return the main pane. */
export async function renderHealthRoute(
  health: Payload,
  pages: Payload = pagesEnvelope(),
): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(healthResponder(health, pages));
  dom.window.location.hash = "#/health";
  await flushMicrotasks();
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

/** Read an element's trimmed text, or "" when the element is absent. */
export function textOf(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}
