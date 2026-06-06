/**
 * Sidebar freshness-filter + corrupt-state-banner DOM tests.
 *
 * Mounts the real viewer assets through `mountViewerDom` and exercises
 * the Slice-9 client surfaces that live in `viewer-sidebar.js` and
 * `viewer.js`: the per-axis freshness `<select>` filter that narrows the
 * loaded `/api/pages` rows client-side, and the corrupt-state banner the
 * health dashboard renders when `/api/health.stateStatus === "corrupt"`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type EmbeddedPage,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

const PAGES_BASE = {
  project: { title: "demo", rootName: "demo" },
  counts: { concepts: 5, queries: 0, sourceFiles: 0, pendingReviews: 0 },
  index: { available: false, href: "/#/index" },
  recentPages: [],
  updatedAt: "2026-05-14T00:00:00.000Z",
};

/** Freshness object shape carried on each `/api/pages` row. */
interface Freshness {
  freshnessStatus: "fresh" | "stale" | "orphaned" | "unverified";
  contradicted: boolean;
  archived: boolean;
}

/** A `/api/pages` row carrying freshness — superset of the embedded blob row. */
interface PageRow extends EmbeddedPage {
  freshness: Freshness;
}

/** Build a concepts row with the given slug + freshness. */
function row(slug: string, freshness: Freshness): PageRow {
  return {
    id: `concepts/${slug}`,
    pageDirectory: "concepts",
    slug,
    title: slug,
    kind: "concept",
    freshness,
  };
}

const STALE = { freshnessStatus: "stale", contradicted: false, archived: false } as const;
const ORPHANED = { freshnessStatus: "orphaned", contradicted: false, archived: false } as const;
const FRESH = { freshnessStatus: "fresh", contradicted: false, archived: false } as const;
const CONTRADICTED = { freshnessStatus: "fresh", contradicted: true, archived: false } as const;
const ARCHIVED = { freshnessStatus: "fresh", contradicted: false, archived: true } as const;

/** A mixed set of pages spanning every freshness axis. */
const MIXED_ROWS: PageRow[] = [
  row("stale-page", STALE),
  row("orphaned-page", ORPHANED),
  row("fresh-page", FRESH),
  row("contradicted-page", CONTRADICTED),
  row("archived-page", ARCHIVED),
];

/** Responder serving `/api/pages` with the given rows; everything else 404s. */
function pagesResponderFor(rows: PageRow[]): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse({ ...PAGES_BASE, pages: rows });
    return null;
  };
}

/** Collect the slugs of every page `<li>` currently shown in the sidebar. */
function visibleSlugs(dom: import("jsdom").JSDOM): string[] {
  const links = dom.window.document.querySelectorAll(
    "[data-sidebar] details[data-kind] li a[data-page-id]",
  );
  return Array.from(links).map((a) => (a as HTMLAnchorElement).dataset.pageId ?? "");
}

/** Fire a `change` event on the freshness `<select>` after setting its value. */
function selectFilter(dom: import("jsdom").JSDOM, value: string): void {
  const select = dom.window.document.querySelector(
    "#freshness-filter-select",
  ) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new dom.window.Event("change"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sidebar freshness filter", () => {
  it("renders the filter <select> with every axis option", async () => {
    const { dom } = await mountViewerDom(MIXED_ROWS, pagesResponderFor(MIXED_ROWS));
    await flushMicrotasks();
    const options = dom.window.document.querySelectorAll("#freshness-filter-select option");
    const values = Array.from(options).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["all", "stale", "orphaned", "contradicted", "archived"]);
  });

  it("narrows to only the stale page when 'stale' is selected, then restores on 'all'", async () => {
    const { dom } = await mountViewerDom(MIXED_ROWS, pagesResponderFor(MIXED_ROWS));
    await flushMicrotasks();
    expect(visibleSlugs(dom).length).toBe(5);

    selectFilter(dom, "stale");
    await flushMicrotasks();
    expect(visibleSlugs(dom)).toEqual(["concepts/stale-page"]);

    selectFilter(dom, "all");
    await flushMicrotasks();
    expect(visibleSlugs(dom).length).toBe(5);
  });

  it("narrows to only the contradicted page when 'contradicted' is selected", async () => {
    const { dom } = await mountViewerDom(MIXED_ROWS, pagesResponderFor(MIXED_ROWS));
    await flushMicrotasks();

    selectFilter(dom, "contradicted");
    await flushMicrotasks();
    expect(visibleSlugs(dom)).toEqual(["concepts/contradicted-page"]);
  });
});

/** Responder serving /api/pages with stateStatus embedded in the envelope. */
function pagesWithStateStatus(stateStatus: string): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages"))
      return jsonResponse({ ...PAGES_BASE, pages: [], stateStatus });
    return null;
  };
}

describe("global corrupt-state banner (home route)", () => {
  it("renders the banner in the main pane at load when stateStatus is corrupt", async () => {
    const { dom } = await mountViewerDom([], pagesWithStateStatus("corrupt"));
    await flushMicrotasks();
    const banner = dom.window.document.querySelector(".corrupt-state-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
  });

  it("does NOT render a global banner when stateStatus is ok", async () => {
    const { dom } = await mountViewerDom([], pagesWithStateStatus("ok"));
    await flushMicrotasks();
    const banner = dom.window.document.querySelector(".corrupt-state-banner");
    expect(banner).toBeNull();
  });
});

/** Responder serving a health payload with the given stateStatus. */
function healthResponderFor(stateStatus: string): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse({ ...PAGES_BASE, pages: [] });
    if (url.endsWith("/api/health")) {
      return jsonResponse({ concepts: 0, queries: 0, stateStatus, lint: null });
    }
    return null;
  };
}

/** Mount the viewer, navigate to #/health, and return the corrupt-banner element (or null). */
async function bannerForStateStatus(stateStatus: string): Promise<Element | null> {
  const { dom } = await mountViewerDom([], healthResponderFor(stateStatus));
  dom.window.location.hash = "#/health";
  await flushMicrotasks();
  return dom.window.document.querySelector(".corrupt-state-banner");
}

describe("corrupt-state banner", () => {
  it("renders the banner when /api/health reports stateStatus: corrupt", async () => {
    const banner = await bannerForStateStatus("corrupt");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
  });

  it("does NOT render the banner when /api/health reports stateStatus: ok", async () => {
    const banner = await bannerForStateStatus("ok");
    expect(banner).toBeNull();
  });
});
