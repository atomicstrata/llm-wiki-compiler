/**
 * List-route contract for #/concepts, #/queries, and #/sources.
 *
 * The freshness filter moved here from the sidebar, so its behaviour is
 * pinned on the concepts route. The sources route reads the snapshot's
 * sourceFilenames; there is no per-file compiled flag anywhere in the
 * snapshot, so rows carry no status dot — the compiled-versus-on-disk
 * fact is pinned once, in the caption.
 */

import { describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

const PAGES = [
  {
    id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha",
    kind: "concept", summary: "", updatedAt: "2026-08-02T00:00:00.000Z", warnings: [],
    freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
    citationCount: 8, unresolvedCitationCount: 0,
  },
  {
    id: "concepts/beta", pageDirectory: "concepts", slug: "beta", title: "Beta",
    kind: "concept", summary: "", updatedAt: "2026-08-01T00:00:00.000Z", warnings: [],
    freshness: { freshnessStatus: "stale", contradicted: false, archived: false },
    citationCount: 3, unresolvedCitationCount: 1,
  },
  {
    id: "queries/why", pageDirectory: "queries", slug: "why", title: "Why?",
    kind: "query", summary: "", updatedAt: "2026-08-03T00:00:00.000Z", warnings: [],
    freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
    citationCount: 2, unresolvedCitationCount: 0,
  },
];

const ENVELOPE = {
  project: { title: "demo", rootName: "demo" },
  stateStatus: "ok",
  profileId: "default",
  counts: {
    concepts: 2, queries: 1, sourceFiles: 2, pendingReviews: 0,
    compiledSources: 1, stale: 1, orphaned: 0,
  },
  graph: { nodeCount: 3, edgeCount: 2, danglingCount: 0 },
  sourceFilenames: ["karpathy.md", "extra.md"],
  index: { available: true, href: "/#/index" },
  recentPages: [],
  pages: PAGES,
  updatedAt: "2026-08-04T10:14:00.000Z",
};

const responder: FetchResponder = (url) => {
  if (url.endsWith("/api/pages")) return jsonResponse(ENVELOPE);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  return null;
};

/** Mount at a hash and return the main pane. */
async function mountAt(hash: string): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(responder, hash);
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

/** Responder serving ENVELOPE with `overrides` applied, plus a not-yet-run lint payload. */
function responderWithEnvelope(overrides: Partial<typeof ENVELOPE>): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse({ ...ENVELOPE, ...overrides });
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    return null;
  };
}

describe("#/concepts", () => {
  it("lists every concept page", async () => {
    const main = await mountAt("#/concepts");
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
  });

  it("shows each page's citation count", async () => {
    const main = await mountAt("#/concepts");
    const counts = Array.from(main.querySelectorAll(".list-citations")).map((n) => n.textContent);
    expect(counts).toContain("8");
  });

  it("marks a stale page with the warning dot", async () => {
    const main = await mountAt("#/concepts");
    expect(main.querySelector(".list-dot.is-warn")).toBeTruthy();
  });

  it("marks an unverified page with the calm dot, not the warning one", async () => {
    // "unverified" (freshness could not be computed, e.g. a missing or
    // corrupt state.json) must read the same as "fresh" — it is not
    // evidence of a problem with the page. Pins the same rule the
    // dashboard's recently-compiled row asserts in viewer-dashboard.test.ts.
    const page = {
      id: "concepts/gamma", pageDirectory: "concepts", slug: "gamma", title: "Gamma",
      kind: "concept", summary: "", updatedAt: "2026-08-01T00:00:00.000Z", warnings: [],
      freshness: { freshnessStatus: "unverified", contradicted: false, archived: false },
      citationCount: 0, unresolvedCitationCount: 0,
    };
    const { dom } = await mountViewerDom(responderWithEnvelope({ pages: [page] }), "#/concepts");
    const dot = dom.window.document.querySelector(".list-dot");
    expect(dot?.className).toContain("is-ok");
    expect(dot?.className).not.toContain("is-warn");
  });

  it("renders the freshness filter", async () => {
    const main = await mountAt("#/concepts");
    expect(main.querySelector("[data-freshness-filter]")).toBeTruthy();
  });

  it("narrows the list when the filter changes to stale", async () => {
    const { dom } = await mountViewerDom(responder, "#/concepts");
    const doc = dom.window.document;
    const select = doc.querySelector("[data-freshness-filter]") as HTMLSelectElement;
    select.value = "stale";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(doc.querySelectorAll(".list-row")).toHaveLength(1);
  });
});

describe("#/queries", () => {
  it("lists only query pages", async () => {
    const main = await mountAt("#/queries");
    const rows = main.querySelectorAll(".list-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Why?");
  });
});

describe("#/sources", () => {
  it("lists every source filename", async () => {
    const main = await mountAt("#/sources");
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
  });

  it("renders a row as just the filename — no per-row status dot exists to show", async () => {
    const main = await mountAt("#/sources");
    const row = main.querySelector(".list-row") as HTMLElement;
    expect(row.querySelector(".list-title")?.textContent).toBe("karpathy.md");
    expect(row.querySelector(".list-dot")).toBeNull();
  });

  it("renders the design system's empty state, with the real CLI command", async () => {
    const { dom } = await mountViewerDom(responderWithEnvelope({ sourceFilenames: [] }), "#/sources");
    const main = dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
    const state = main.querySelector(".empty-state");
    expect(state).toBeTruthy();
    expect(state?.querySelector(".empty-state-command")?.textContent).toBe("$ llmwiki ingest <source>");
  });
});

describe("empty-state copy", () => {
  it("distinguishes a filtered-to-empty list from an empty project", async () => {
    const { dom } = await mountViewerDom(responderWithEnvelope({ pages: [] }), "#/concepts");
    const doc = dom.window.document;
    expect(doc.querySelector(".empty-state-title")?.textContent).toBe("No concepts yet");
    const select = doc.querySelector("[data-freshness-filter]") as HTMLSelectElement;
    select.value = "stale";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(doc.querySelector(".empty-state-title")?.textContent).toBe("No pages match this filter");
  });

  it("names only commands the CLI actually registers", async () => {
    const { dom } = await mountViewerDom(responderWithEnvelope({ pages: [] }), "#/queries");
    const command = dom.window.document.querySelector(".empty-state-command")?.textContent ?? "";
    // The design system's own example said `llmwiki ask`, which does not exist.
    expect(command).not.toContain("llmwiki ask");
    expect(command).toContain("llmwiki query");
  });
});
