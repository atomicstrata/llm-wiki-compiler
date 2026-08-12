/**
 * Accessibility + Slice 5 UI integration tests for the viewer client.
 *
 * Mounts the real shell template + `viewer.js` + `viewer-search.js`
 * into JSDOM via the shared `mountViewerDom` fixture. Asserts the
 * landmark structure, the focus-visible outline rule in the stylesheet,
 * the wired search input (including its header ⌘K / Ctrl+K shortcut),
 * the `/#/health` dashboard rendering, and that colour is never the only
 * signal — the theme toggle's `aria-pressed` state and every freshness
 * dot's `aria-label`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import type { JSDOM } from "jsdom";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

// The universal `:focus-visible` rule lives in viewer-tokens.css (the
// global reset/token sheet), not a per-surface stylesheet — viewer.css,
// which used to own it, has since been deleted.
const STYLESHEET_PATH = path.resolve("src/viewer/assets/viewer-tokens.css");

interface SearchResultRow {
  id: string;
  pageDirectory: "concepts" | "queries";
  title: string;
  snippet: string;
  matchedIn: "title" | "body";
}

function pagesResponse(): Response {
  return jsonResponse({
    project: { title: "demo", rootName: "demo" },
    counts: { concepts: 1, queries: 0, sourceFiles: 0, pendingReviews: 0 },
    index: { available: false, href: "/#/index" },
    recentPages: [],
    pages: [],
    updatedAt: "2026-05-12T00:00:00.000Z",
  });
}

async function typeIntoSearch(dom: JSDOM, value: string, waitMs: number): Promise<void> {
  const input = dom.window.document.querySelector("[data-search-input]") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input"));
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

function makeResponder(
  searchResults: SearchResultRow[],
  healthPayload?: Record<string, unknown>,
): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return pagesResponse();
    if (url.includes("/api/search")) return jsonResponse({ results: searchResults });
    if (url.endsWith("/api/health")) return jsonResponse(healthPayload ?? {});
    return null;
  };
}

/**
 * One page that is both a "recently compiled" entry and stale, so
 * mounting the default (home) route paints at least one real
 * `.list-dot` — the dashboard's recent-pages panel shares that dot
 * with the list routes (see viewer-dashboard.css). Without a page
 * here, the freshness-dot accessibility test below would iterate an
 * empty NodeList and pass vacuously.
 */
function defaultViewerResponder(): FetchResponder {
  const page = {
    id: "concepts/alpha",
    pageDirectory: "concepts" as const,
    slug: "alpha",
    title: "Alpha",
    updatedAt: "2026-05-01T00:00:00.000Z",
    citationCount: 1,
    unresolvedCitationCount: 0,
    freshness: { freshnessStatus: "stale", contradicted: false, archived: false },
  };
  return (url) => {
    if (url.endsWith("/api/pages")) {
      return jsonResponse({
        project: { title: "demo", rootName: "demo" },
        counts: { concepts: 1, queries: 0, sourceFiles: 0, pendingReviews: 0 },
        index: { available: false, href: "/#/index" },
        recentPages: [page],
        pages: [page],
        updatedAt: "2026-05-12T00:00:00.000Z",
      });
    }
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    return null;
  };
}

/** Mount the shell at its default (home) route and return the document. */
async function mountDefaultViewer(): Promise<Document> {
  const { dom } = await mountViewerDom(defaultViewerResponder());
  return dom.window.document;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shell template — accessibility landmarks + skip link", () => {
  it("ships the four named landmarks plus a skip link to the main pane", async () => {
    const { dom } = await mountViewerDom(makeResponder([]));
    const doc = dom.window.document;
    expect(doc.querySelector("header.app-header")).not.toBeNull();
    const logo = doc.querySelector(".app-logo") as HTMLImageElement | null;
    expect(logo).not.toBeNull();
    expect(logo!.getAttribute("src")).toBe("/assets/llmwiki-logo-64.png");
    expect(doc.querySelector("nav.sidebar")).not.toBeNull();
    expect(doc.querySelector("main#main-pane")).not.toBeNull();
    expect(doc.querySelector("aside.support-rail")).not.toBeNull();
    const skip = doc.querySelector(".skip-link") as HTMLAnchorElement | null;
    expect(skip).not.toBeNull();
    expect(skip!.getAttribute("href")).toBe("#main-pane");
    const github = doc.querySelector(".github-link") as HTMLAnchorElement | null;
    expect(github).not.toBeNull();
    expect(github!.getAttribute("href")).toBe("https://github.com/atomicstrata/llm-wiki-compiler");
    expect(github!.getAttribute("aria-label")).toBe("Open llm-wiki-compiler on GitHub, 1.3k stars");
    expect(github!.textContent).toContain("GitHub");
    expect(github!.textContent).toContain("1.3k");
  });

  it("stylesheet declares a universal `:focus-visible` outline so keyboard focus is visible", async () => {
    const css = await readFile(STYLESHEET_PATH, "utf-8");
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline\s*:/);
  });
});

/**
 * Build a fetch responder that returns a Promise the test can fulfill
 * on demand for each unique URL substring. Lets a test simulate
 * out-of-order network responses (slow first request, fast second).
 */
function makeDeferredResponder(searchByQuery: Record<string, Response | "defer">): {
  responder: FetchResponder;
  resolve(query: string, response: Response): void;
} {
  const deferrals = new Map<string, (res: Response) => void>();
  return {
    responder: (url) => {
      if (url.endsWith("/api/pages")) return pagesResponse();
      const match = url.match(/\/api\/search\?q=([^&]+)/);
      if (match) {
        const query = decodeURIComponent(match[1]);
        const setup = searchByQuery[query];
        if (setup === "defer") {
          return new Promise<Response>((resolve) => {
            deferrals.set(query, resolve);
          });
        }
        if (setup) return setup;
        return jsonResponse({ results: [] });
      }
      return null;
    },
    resolve(query, response) {
      const resolver = deferrals.get(query);
      if (!resolver) throw new Error(`no pending fetch for q=${query}`);
      resolver(response);
      deferrals.delete(query);
    },
  };
}

describe("search UI — input wires up and renders results", () => {
  it("debounces input and renders search results from /api/search", async () => {
    const { dom } = await mountViewerDom(
      makeResponder([
        {
          id: "concepts/alpha",
          pageDirectory: "concepts",
          title: "Alpha",
          snippet: "matched on title",
          matchedIn: "title",
        },
      ]),
    );
    await typeIntoSearch(dom, "alpha", 250);
    const results = dom.window.document.querySelector("[data-search-results]") as HTMLElement;
    expect(results.hidden).toBe(false);
    const anchors = results.querySelectorAll("a[data-search-result]");
    expect(anchors.length).toBe(1);
    const link = anchors[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/concepts/alpha");
    expect(link.textContent).toContain("Alpha");
    expect(link.textContent).toContain("matched on title");
  });

  it("cancels a pending debounced fetch when the input is cleared", async () => {
    const { dom, fetchMock } = await mountViewerDom(
      makeResponder([
        { id: "concepts/x", pageDirectory: "concepts", title: "X", snippet: "x", matchedIn: "title" },
      ]),
    );
    // Clear before the 200 ms debounce fires.
    await typeIntoSearch(dom, "alpha", 50);
    await typeIntoSearch(dom, "", 250);
    const searchCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/search"));
    expect(searchCalls).toEqual([]);
    const results = dom.window.document.querySelector("[data-search-results]") as HTMLElement;
    expect(results.hidden).toBe(true);
    expect(results.querySelectorAll("a[data-search-result]")).toHaveLength(0);
  });

  it("discards a stale older response when a newer query supersedes it", async () => {
    const { responder, resolve } = makeDeferredResponder({ alpha: "defer", beta: "defer" });
    const { dom } = await mountViewerDom(responder);
    // Both fetches need to be in flight before we resolve them out of
    // order — wait past the debounce window after each typed query.
    await typeIntoSearch(dom, "alpha", 250);
    await typeIntoSearch(dom, "beta", 250);
    // Resolve newer first, then older — the older response must be
    // discarded by the generation guard.
    resolve("beta", jsonResponse({
      results: [{ id: "concepts/beta", pageDirectory: "concepts", title: "Beta Result", snippet: "newer", matchedIn: "title" }],
    }));
    await new Promise<void>((r) => setTimeout(r, 10));
    resolve("alpha", jsonResponse({
      results: [{ id: "concepts/alpha", pageDirectory: "concepts", title: "Alpha Result", snippet: "older", matchedIn: "title" }],
    }));
    await new Promise<void>((r) => setTimeout(r, 25));
    const results = dom.window.document.querySelector("[data-search-results]") as HTMLElement;
    const titles = Array.from(results.querySelectorAll(".result-title")).map((n) => n.textContent);
    expect(titles).toEqual(["Beta Result"]);
    expect(titles).not.toContain("Alpha Result");
  });

  it("clicking a search result navigates to the page and renders the fetched HTML", async () => {
    const pageHtml = "<p>Body for <strong>alpha</strong>.</p>";
    const responder: FetchResponder = (url) => {
      if (url.endsWith("/api/pages")) return pagesResponse();
      if (url.includes("/api/search")) {
        return jsonResponse({
          results: [
            { id: "concepts/alpha", pageDirectory: "concepts", title: "Alpha", snippet: "match", matchedIn: "title" },
          ],
        });
      }
      if (url.includes("/api/page/concepts/alpha")) {
        return jsonResponse({
          id: "concepts/alpha",
          pageDirectory: "concepts",
          slug: "alpha",
          title: "Alpha",
          html: pageHtml,
          citations: [],
          outgoingLinks: [],
          frontmatter: {},
          warnings: [],
          updatedAt: "",
          createdAt: "",
          generatedAt: "2026-05-12T00:00:00.000Z",
        });
      }
      return null;
    };
    const { dom } = await mountViewerDom(responder);
    await typeIntoSearch(dom, "alpha", 250);
    const link = dom.window.document.querySelector(
      "a[data-search-result]",
    ) as HTMLAnchorElement;
    link.click();
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(dom.window.location.hash).toBe("#/concepts/alpha");
    const main = dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
    expect(main.textContent).toContain("Alpha");
    expect(main.querySelector("strong")?.textContent).toBe("alpha");
    // Search results panel is hidden after selection.
    const results = dom.window.document.querySelector("[data-search-results]") as HTMLElement;
    expect(results.hidden).toBe(true);
  });

  it("focuses and selects the search input on Ctrl+K, without leaking the shortcut to other fields", async () => {
    const { dom } = await mountViewerDom(makeResponder([]));
    const doc = dom.window.document;
    const input = doc.querySelector("[data-search-input]") as HTMLInputElement;
    input.value = "stale query";
    // A keydown on an unrelated element must not trigger the shortcut —
    // the chip's binding is global, but typing "k" into other fields is not.
    const elsewhere = doc.createElement("input");
    doc.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
    expect(doc.activeElement).not.toBe(input);
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    doc.dispatchEvent(event);
    expect(doc.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
    // select(), not just focus() — the whole point is that typing
    // immediately replaces the previous query rather than appending to it.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
});

describe("/#/health route — dashboard renders from /api/health", () => {
  it("renders concepts/queries/sources/pendingReviews from the payload", async () => {
    const { dom } = await mountViewerDom(
      makeResponder([], {
        concepts: 3,
        queries: 2,
        sources: 1,
        sourceFiles: 5,
        pendingReviews: 4,
        lint: null,
      }),
    );
    dom.window.location.hash = "#/health";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
    expect(main.textContent).toContain("Health");
    expect(main.textContent).toContain("Concepts");
    expect(main.textContent).toContain("3");
    expect(main.textContent).toContain("Saved queries");
    // The five stat cards are now one CONTENTS strip whose Sources column
    // carries sourceFiles with the compiled count as its suffix (see
    // test/viewer-health-dashboard.test.ts for the strip's own assertions).
    expect(main.textContent).toContain("Sources");
    expect(main.textContent).toContain("1 compiled");
    expect(main.textContent).toContain("Awaiting review");
    expect(main.textContent).toContain("4");
    expect(main.textContent).toContain("No cached lint summary");
  });

  it("renders cached lint summary when present", async () => {
    const { dom } = await mountViewerDom(
      makeResponder([], {
        concepts: 0, queries: 0, sources: 0, sourceFiles: 0, pendingReviews: 0,
        lint: { warnings: 2, errors: 1, at: "2026-05-12T00:00:00.000Z" },
      }),
    );
    dom.window.location.hash = "#/health";
    await flushMicrotasks();
    const main = dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
    // The lint cache now drives the Lint panel's chip and figures rather
    // than a definition list, and the run time moved to the page head's
    // caption in the viewer's own UTC format.
    expect(main.textContent).toContain("3 PROBLEMS");
    expect(main.textContent).toContain("warnings");
    expect(main.textContent).toContain("error");
    expect(main.textContent).toContain("lint last run 2026-05-12 00:00Z");
  });
});

describe("sidebar — Health entry routes to #/health", () => {
  it("renders a Health link with href=#/health in the sidebar", async () => {
    const { dom } = await mountViewerDom(makeResponder([]));
    const link = dom.window.document.querySelector(
      "[data-route='health']",
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("#/health");
  });
});

describe("header + freshness dots — colour is never the only signal", () => {
  it("gives the theme toggle an accessible name and pressed state", async () => {
    const doc = await mountDefaultViewer();
    const button = doc.querySelector("[data-theme-toggle]");
    expect(button?.getAttribute("aria-label")).toBeTruthy();
    expect(button?.getAttribute("aria-pressed")).toMatch(/true|false/);
  });

  it("labels freshness dots so colour is never the only signal", async () => {
    const doc = await mountDefaultViewer();
    const dots = doc.querySelectorAll(".list-dot");
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      expect(dot.getAttribute("aria-label")).toBeTruthy();
    }
  });
});
