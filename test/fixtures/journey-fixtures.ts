/**
 * Shared helpers for the P9.4 research-journey DOM witnesses: the minimal
 * `/api/pages` bootstrap body (the banner fetch `main()` always fires), an
 * externally-resolvable deferred for stale-navigation timing, and the
 * main-pane accessor.
 */

import type { JSDOM } from "jsdom";
import { jsonResponse } from "./viewer-jsdom.js";

/** Minimal `/api/pages` bootstrap body used by every journey mount. */
export function pagesResponse(): Response {
  return jsonResponse({
    project: { title: "demo", rootName: "demo" },
    counts: { concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0 },
    index: { available: false, href: "/#/index" },
    recentPages: [], pages: [], updatedAt: "2026-08-29T00:00:00.000Z",
  });
}

/** An externally-resolvable promise, for deferring a slow fetch response. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The viewer's main-pane element after a render. */
export function mainPane(dom: JSDOM): HTMLElement {
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}
