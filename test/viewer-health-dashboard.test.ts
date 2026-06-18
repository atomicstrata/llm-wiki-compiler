/**
 * DOM-level tests for the health dashboard pane rendered by viewer.js.
 *
 * Navigates to `#/health` via the JSDOM harness and asserts that the
 * stale and orphaned row counts from `/api/health` are visible in the
 * rendered `<dl class="metric-list">`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type EmbeddedPage,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

const EMPTY_PAGES: EmbeddedPage[] = [];

/** Build a fetch responder that serves the given health payload. */
function healthResponder(health: Record<string, unknown>): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) {
      return jsonResponse({ project: { title: "demo" }, counts: {}, pages: [], recentPages: [], index: { available: false } });
    }
    if (url.endsWith("/api/health")) return jsonResponse(health);
    return null;
  };
}

/** Mount the viewer, navigate to #/health, and return the main pane element. */
async function renderHealthPane(health: Record<string, unknown>): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(EMPTY_PAGES, healthResponder(health));
  dom.window.location.hash = "#/health";
  await flushMicrotasks();
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a /api/pages responder carrying a given stateStatus, plus /api/health. */
function pagesResponder(stateStatus: string): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) {
      return jsonResponse({
        project: { title: "demo" },
        counts: {},
        pages: [],
        recentPages: [],
        index: { available: false },
        stateStatus,
      });
    }
    if (url.endsWith("/api/health")) return jsonResponse({ stateStatus });
    return null;
  };
}

/** Mount the viewer with a given bootstrap stateStatus and return its document. */
async function mountWithStateStatus(stateStatus: string): Promise<Document> {
  const { dom } = await mountViewerDom(EMPTY_PAGES, pagesResponder(stateStatus));
  return dom.window.document;
}

describe("state-status banner — corrupt and too-new", () => {
  it("renders the corrupt banner when stateStatus is corrupt", async () => {
    const doc = await mountWithStateStatus("corrupt");
    const banner = doc.querySelector(".corrupt-state-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("corrupt");
  });

  it("renders the too-new banner when stateStatus is too-new", async () => {
    const doc = await mountWithStateStatus("too-new");
    const banner = doc.querySelector(".corrupt-state-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("newer version of llmwiki");
  });

  it("renders no banner when stateStatus is ok", async () => {
    const doc = await mountWithStateStatus("ok");
    expect(doc.querySelector(".corrupt-state-banner")).toBeNull();
  });
});

describe("health dashboard — stale and orphaned counts", () => {
  it("renders the 'Stale pages' row with the count from /api/health", async () => {
    const main = await renderHealthPane({ stale: 3, orphaned: 0 });
    expect(main.textContent).toContain("Stale pages");
    expect(main.textContent).toContain("3");
  });

  it("renders the 'Orphaned pages' row with the count from /api/health", async () => {
    const main = await renderHealthPane({ stale: 0, orphaned: 1 });
    expect(main.textContent).toContain("Orphaned pages");
    expect(main.textContent).toContain("1");
  });

  it("renders both stale and orphaned counts together", async () => {
    const main = await renderHealthPane({ stale: 2, orphaned: 1 });
    const metrics = main.querySelector(".metric-list") as HTMLElement;
    const dtElements = Array.from(metrics.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(dtElements).toContain("Stale pages");
    expect(dtElements).toContain("Orphaned pages");
    // Verify the values are in corresponding <dd> elements.
    const ddElements = Array.from(metrics.querySelectorAll("dd")).map((dd) => dd.textContent);
    expect(ddElements).toContain("2");
    expect(ddElements).toContain("1");
  });

  it("defaults to 0 for stale and orphaned when absent from health response", async () => {
    const main = await renderHealthPane({});
    expect(main.textContent).toContain("Stale pages");
    expect(main.textContent).toContain("Orphaned pages");
  });
});
