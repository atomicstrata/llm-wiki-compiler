/**
 * Pattern strip dismiss/persistence contract.
 *
 * These tests pin the strip's dismiss mechanism: a real button, immediate
 * removal on click, persistence across a re-render, and a fail-open default
 * when storage is unavailable (private browsing, disabled storage) so a
 * throwing localStorage can never take the whole dashboard down with it.
 * Regression guard for the same class of bug as the graph panel's
 * Fit/expand chips (commit c786404): a control that LOOKS real but does
 * nothing.
 *
 * The mockup's "shown until you dismiss it" caption is intentionally gone —
 * it described an affordance the static mockup could not draw, and the "×"
 * now carries that meaning itself. The first test keeps it from creeping
 * back as redundant narration beside the button.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_DEMO_ENVELOPE,
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

/** Same key namespace as viewer-theme.js's "llmwiki-viewer-theme". */
const STORAGE_KEY = "llmwiki-viewer-pattern-dismissed";

const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) return jsonResponse(EMPTY_DEMO_ENVELOPE);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  if (url.endsWith("/api/graph")) return jsonResponse({ nodes: [], edges: [] });
  return null;
};

/** A localStorage stand-in whose every method throws, modelling private browsing / disabled storage. */
function throwingStorage() {
  return {
    getItem(): string | null {
      throw new Error("storage disabled");
    },
    setItem(): void {
      throw new Error("storage disabled");
    },
  };
}

describe("pattern strip dismiss control", () => {
  it("states dismissibility through the button alone, with no caption narrating it", async () => {
    const { dom } = await mountViewerDom(responder);
    const head = dom.window.document.querySelector(".pattern-head");
    expect(head?.querySelector("[data-pattern-dismiss]")).toBeTruthy();
    expect(head?.textContent).not.toMatch(/dismiss/i);
  });

  it("renders the dismiss control as a real button with an accessible name, not a bare glyph", async () => {
    const { dom } = await mountViewerDom(responder);
    const button = dom.window.document.querySelector("[data-pattern-dismiss]");
    expect(button?.tagName).toBe("BUTTON");
    const label = button?.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).not.toBe("×");
    expect(label).toMatch(/dismiss/i);
  });

  it("removes the strip from the DOM immediately on click", async () => {
    const { dom } = await mountViewerDom(responder);
    expect(dom.window.document.querySelector(".pattern-strip")).toBeTruthy();
    const button = dom.window.document.querySelector("[data-pattern-dismiss]") as HTMLButtonElement;
    button.click();
    expect(dom.window.document.querySelector(".pattern-strip")).toBeNull();
  });

  it("persists the dismissal to localStorage on click", async () => {
    const { dom } = await mountViewerDom(responder);
    const button = dom.window.document.querySelector("[data-pattern-dismiss]") as HTMLButtonElement;
    button.click();
    expect(dom.window.localStorage.getItem(STORAGE_KEY)).toBeTruthy();
  });

  it("does not build the strip on a render where the dismissal is already stored", async () => {
    const { dom } = await mountViewerDom(responder);
    dom.window.localStorage.setItem(STORAGE_KEY, "1");
    // Force a fresh dashboard render against the now-stored dismissal —
    // hashchange re-runs renderDashboard, which calls buildPatternStrip()
    // again from scratch (see viewer.js's applyHomeEnvelope).
    dom.window.location.hash = "#/graph";
    await flushMicrotasks();
    dom.window.location.hash = "#/";
    await flushMicrotasks();
    expect(dom.window.document.querySelector(".pattern-strip")).toBeNull();
  });

  it("still renders the strip, and the rest of the dashboard, when a storage read throws", async () => {
    const { dom } = await mountViewerDom(responder);
    Object.defineProperty(dom.window, "localStorage", { configurable: true, value: throwingStorage() });
    dom.window.location.hash = "#/graph";
    await flushMicrotasks();
    dom.window.location.hash = "#/";
    await flushMicrotasks();
    expect(dom.window.document.querySelector(".pattern-strip")).toBeTruthy();
    // A throwing read must never take down the whole render, only the
    // strip's own visibility decision.
    expect(dom.window.document.querySelector(".stat-grid")).toBeTruthy();
  });

  it("still removes the strip on click when persisting the dismissal throws", async () => {
    const { dom } = await mountViewerDom(responder);
    Object.defineProperty(dom.window, "localStorage", { configurable: true, value: throwingStorage() });
    const button = dom.window.document.querySelector("[data-pattern-dismiss]") as HTMLButtonElement;
    expect(() => button.click()).not.toThrow();
    expect(dom.window.document.querySelector(".pattern-strip")).toBeNull();
  });
});
