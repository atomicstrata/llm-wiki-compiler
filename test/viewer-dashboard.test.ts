/**
 * Overview dashboard contract.
 *
 * The four stat cards keep the mockup's inventory/signal split. "Needs
 * attention" is built from dangling links plus unresolved citations —
 * both always present in the snapshot — rather than the lint cache, which
 * is null until `llmwiki lint` first runs and would render the design's
 * focal card blank on a fresh project.
 */

import { describe, expect, it } from "vitest";
import { jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

/** Build an envelope with the given dangling count and citation totals. */
function envelopeWith(danglingCount: number, unresolved: number) {
  return {
    project: { title: "my-llm-wiki", rootName: "my-llm-wiki" },
    stateStatus: "ok",
    profileId: "default",
    counts: {
      concepts: 7, queries: 0, sourceFiles: 1, pendingReviews: 0,
      compiledSources: 1, stale: 0, orphaned: 0,
    },
    graph: { nodeCount: 128, edgeCount: 256, danglingCount },
    sourceFilenames: ["karpathy.md"],
    index: { available: true, href: "/#/index" },
    recentPages: [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha",
        title: "Alpha", updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
    pages: [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha",
        kind: "concept", summary: "", updatedAt: "2026-08-02T00:00:00.000Z", warnings: [],
        freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
        citationCount: 8, unresolvedCitationCount: unresolved },
    ],
    updatedAt: "2026-08-04T10:14:00.000Z",
  };
}

/** Build the /api/pages + /api/health + /api/graph responder a dashboard mount needs. */
function dashboardResponder(envelope: unknown, lint: unknown = null): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelope);
    if (url.endsWith("/api/health")) return jsonResponse({ lint });
    if (url.endsWith("/api/graph")) return jsonResponse({ nodes: [], edges: [] });
    return null;
  };
}

/**
 * Mount the home route with a given /api/pages envelope and lint payload,
 * and return its main pane. The one responder-building implementation —
 * `mountDashboard` below is a thin convenience wrapper over this rather
 * than a second copy.
 */
async function mountDashboardWithEnvelope(
  envelope: unknown,
  lint: unknown = null,
): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(dashboardResponder(envelope, lint));
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

/** Mount the home route with the dangling/unresolved shortcut envelope and a lint block. */
async function mountDashboard(
  danglingCount: number,
  unresolved: number,
  lint: unknown = null,
): Promise<HTMLElement> {
  return mountDashboardWithEnvelope(envelopeWith(danglingCount, unresolved), lint);
}

/** Read a stat card by its data-stat key. */
function statValue(main: HTMLElement, key: string): string {
  return main.querySelector(`[data-stat="${key}"] .stat-value`)?.textContent ?? "";
}

describe("dashboard stat cards", () => {
  it("renders the concepts count", async () => {
    const main = await mountDashboard(11, 0);
    expect(statValue(main, "concepts")).toBe("7");
  });

  it("sums dangling links and unresolved citations into needs-attention", async () => {
    const main = await mountDashboard(11, 3);
    expect(statValue(main, "attention")).toBe("14");
  });

  it("styles needs-attention as a warning only when non-zero", async () => {
    const warn = await mountDashboard(11, 0);
    expect(warn.querySelector('[data-stat="attention"]')?.className).toContain("is-warn");
    const calm = await mountDashboard(0, 0);
    expect(calm.querySelector('[data-stat="attention"]')?.className).not.toContain("is-warn");
  });

  it("renders needs-attention without a lint cache", async () => {
    const main = await mountDashboard(4, 0, null);
    expect(statValue(main, "attention")).toBe("4");
  });

  it("shows the compiled/on-disk sub-line on the sources card", async () => {
    const main = await mountDashboard(0, 0);
    const sub = main.querySelector('[data-stat="sources"] .stat-sub')?.textContent ?? "";
    expect(sub).toContain("1 compiled");
    expect(sub).toContain("1 on disk");
  });

  it("scopes the concepts sub-line to concept pages, excluding queries", async () => {
    const base = envelopeWith(0, 0);
    const envelope = {
      ...base,
      counts: { ...base.counts, concepts: 1, queries: 1 },
      pages: [
        { ...base.pages[0], citationCount: 5, unresolvedCitationCount: 0 },
        { id: "queries/q1", pageDirectory: "queries", slug: "q1", title: "Q1",
          kind: "query", summary: "", updatedAt: "2026-08-02T00:00:00.000Z", warnings: [],
          freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
          citationCount: 3, unresolvedCitationCount: 0 },
      ],
    };
    const main = await mountDashboardWithEnvelope(envelope);
    const sub = main.querySelector('[data-stat="concepts"] .stat-sub')?.textContent ?? "";
    // "1 page", not "1 pages" — plural() keeps the noun singular at exactly
    // one (see test/viewer-format.test.ts).
    expect(sub).toBe("5 citations · 1 page");
  });
});

describe("dashboard panels", () => {
  it("renders the recently-compiled list", async () => {
    const main = await mountDashboard(0, 0);
    expect(main.querySelector(".recent-row")).toBeTruthy();
  });

  it("shows the recently-compiled footer's 'All N concepts' link with correct singular/plural", async () => {
    const singular = envelopeWith(0, 0);
    singular.counts.concepts = 1;
    const main = await mountDashboardWithEnvelope(singular);
    const footer = main.querySelector(".panel:not(.graph-panel) .panel-footer");
    expect(footer?.textContent).toContain("All 1 concept →");
    expect(footer?.textContent).not.toContain("All 1 concepts");
  });

  it("renders a citations-resolved bar in the compile receipt", async () => {
    const main = await mountDashboard(0, 2);
    // The receipt renders into the shared support rail, not inside main —
    // see viewer-rail.js renderDashboardRail and the rail-unification
    // tests below.
    const receipt = main.ownerDocument!.querySelector("[data-compile-receipt]") as HTMLElement;
    expect(receipt.textContent).toContain("Citations resolved");
    // Design system's two-segment meter: a filled portion plus a distinct
    // remainder segment, not a single bar — pin the structure, not just the label.
    expect(receipt.querySelector(".bar-track > .bar-fill + .bar-remainder")).toBeTruthy();
  });

  it("lists a dangling-link next action when links dangle", async () => {
    const main = await mountDashboard(11, 0);
    const nextActions = main.ownerDocument!.querySelector("[data-next-actions]");
    expect(nextActions?.textContent).toContain("11 dangling");
  });

  it("pluralises the dangling-link next action, singular at exactly one", async () => {
    const main = await mountDashboard(1, 0);
    const nextActions = main.ownerDocument!.querySelector("[data-next-actions]");
    expect(nextActions?.textContent).toContain("Resolve 1 dangling link");
    expect(nextActions?.textContent).not.toContain("dangling links");
  });

  it("omits the dangling next action when nothing dangles", async () => {
    const main = await mountDashboard(0, 0);
    const nextActions = main.ownerDocument!.querySelector("[data-next-actions]");
    expect(nextActions?.textContent).not.toContain("dangling");
  });

  it("pluralises the graph panel's dangling-target count, singular at exactly one", async () => {
    // Regression guard for the "1 dangling targets" bug: the footer used to
    // hardcode a plural "targets" suffix regardless of count.
    const one = await mountDashboard(1, 0);
    const oneFooter = one.querySelector(".graph-panel .panel-footer");
    expect(oneFooter?.textContent).toContain("1 dangling target");
    expect(oneFooter?.textContent).not.toContain("1 dangling targets");

    const two = await mountDashboard(2, 0);
    const twoFooter = two.querySelector(".graph-panel .panel-footer");
    expect(twoFooter?.textContent).toContain("2 dangling targets");
  });

  it("pluralises the graph panel's node/edge caption at exactly one of either", async () => {
    const base = envelopeWith(0, 0);
    const envelope = { ...base, graph: { ...base.graph, nodeCount: 1, edgeCount: 1 } };
    const main = await mountDashboardWithEnvelope(envelope);
    const caption = main.querySelector(".graph-panel .panel-caption")?.textContent ?? "";
    expect(caption).toBe("1 node · 1 edge");
  });

  it("reserves a container for the graph panel", async () => {
    const main = await mountDashboard(0, 0);
    expect(main.querySelector("[data-graph-panel]")).toBeTruthy();
  });

  it("renders the four-item graph legend with a text label per entry", async () => {
    const main = await mountDashboard(0, 0);
    const legend = main.querySelector(".panel-legend");
    expect(legend).toBeTruthy();
    for (const label of ["concept", "entity", "stale", "dangling"]) {
      expect(legend?.textContent).toContain(label);
    }
  });
});

/**
 * The Fit / expand controls in the graph panel's head. Regression guard for
 * a reported bug: both used to be inert `<span class="panel-chip">`s with no
 * handler — styled like buttons but doing nothing on click.
 */
describe("dashboard graph panel controls", () => {
  it("renders Fit as a real button with an accessible name, not an inert span", async () => {
    const { dom } = await mountViewerDom(dashboardResponder(envelopeWith(0, 0)));
    const fit = dom.window.document.querySelector("[data-graph-fit]");
    expect(fit?.tagName).toBe("BUTTON");
    expect(fit?.textContent?.trim()).toBe("Fit");
  });

  it("renders the expand control as a link to #/graph with an accessible name", async () => {
    const { dom } = await mountViewerDom(dashboardResponder(envelopeWith(0, 0)));
    const expand = dom.window.document.querySelector(".graph-panel .panel-controls a");
    expect(expand?.tagName).toBe("A");
    expect(expand?.getAttribute("href")).toBe("#/graph");
    expect(expand?.getAttribute("aria-label")).toBeTruthy();
  });

  it("starts Fit disabled and enables it once loadGraph resolves a handle", async () => {
    const { dom, resolveGraphHandle, flush } = await mountViewerDom(
      dashboardResponder(envelopeWith(0, 0)), undefined, "deferred",
    );
    const fit = dom.window.document.querySelector("[data-graph-fit]") as HTMLButtonElement;
    expect(fit.disabled).toBe(true);
    resolveGraphHandle("present");
    await flush();
    expect(fit.disabled).toBe(false);
  });

  it("keeps Fit disabled when loadGraph yields no handle", async () => {
    const { dom, resolveGraphHandle, flush } = await mountViewerDom(
      dashboardResponder(envelopeWith(0, 0)), undefined, "deferred",
    );
    resolveGraphHandle("none");
    await flush();
    const fit = dom.window.document.querySelector("[data-graph-fit]") as HTMLButtonElement;
    expect(fit.disabled).toBe(true);
  });

  it("invokes the graph handle's fit() when Fit is clicked", async () => {
    const { dom, graphFitMock } = await mountViewerDom(dashboardResponder(envelopeWith(0, 0)));
    const fit = dom.window.document.querySelector("[data-graph-fit]") as HTMLButtonElement;
    fit.click();
    expect(graphFitMock).toHaveBeenCalledTimes(1);
  });
});

describe("dashboard recently-compiled freshness dot", () => {
  it("renders the calm dot for unverified freshness, not the warning one", async () => {
    // "unverified" (freshness could not be computed, e.g. a missing or
    // corrupt state.json) must read the same as "fresh" — it is not
    // evidence of a problem with the page. Pins the same rule the
    // #/concepts list route asserts in viewer-lists.test.ts.
    const base = envelopeWith(0, 0);
    const envelope = {
      ...base,
      pages: [
        { ...base.pages[0], freshness: { freshnessStatus: "unverified", contradicted: false, archived: false } },
      ],
    };
    const main = await mountDashboardWithEnvelope(envelope);
    const dot = main.querySelector(".recent-row .list-dot");
    expect(dot?.className).toContain("is-ok");
    expect(dot?.className).not.toContain("is-warn");
  });

  it("tints the citation figure to match the dot for a warn-freshness row", async () => {
    // Both derive from the same isWarnFreshness() predicate (viewer-format.js)
    // so a stale/orphaned row can never show a violet figure beside an amber
    // dot — the two disagreeing about one page's freshness is the bug this
    // guards against.
    const base = envelopeWith(0, 0);
    const envelope = {
      ...base,
      pages: [{ ...base.pages[0], freshness: { freshnessStatus: "stale", contradicted: false, archived: false } }],
    };
    const main = await mountDashboardWithEnvelope(envelope);
    const dot = main.querySelector(".recent-row .list-dot");
    const figure = main.querySelector(".recent-row .recent-citations");
    expect(dot?.className).toContain("is-warn");
    expect(figure?.className).toContain("is-warn");
  });
});

describe("dashboard recently-compiled citation count", () => {
  it("renders the page's citation count, joined from pages[] by id", async () => {
    // recentPages[] carries no citationCount of its own (see snapshot.ts
    // buildRecentPages) — this joins it from the matching pages[] row by
    // id, the same way freshness is joined.
    const main = await mountDashboard(0, 0);
    const metric = main.querySelector(".recent-row .recent-citations");
    expect(metric?.textContent).toBe("8");
  });

  it("renders 0 for an uncited page rather than leaving the cell blank", async () => {
    // Matches the #/concepts list row's own fallback (viewer-lists.js
    // buildCitationCount) so the two surfaces agree, and keeps the age
    // column's alignment instead of collapsing the cell.
    const base = envelopeWith(0, 0);
    const envelope = {
      ...base,
      pages: [{ ...base.pages[0], citationCount: 0, unresolvedCitationCount: 0 }],
    };
    const main = await mountDashboardWithEnvelope(envelope);
    const metric = main.querySelector(".recent-row .recent-citations");
    expect(metric?.textContent).toBe("0");
  });
});

describe("dashboard rail unification", () => {
  it("renders the receipt, next actions, and snapshot note into the shared support rail, not a second rail inside main", async () => {
    const main = await mountDashboard(0, 0);
    const rail = main.ownerDocument!.querySelector("[data-support-rail]") as HTMLElement;
    expect(rail.querySelector("[data-compile-receipt]")).toBeTruthy();
    expect(rail.querySelector("[data-next-actions]")).toBeTruthy();
    expect(rail.querySelector(".snapshot-note")).toBeTruthy();
    // Regression guard: the dashboard must not also build its own rail
    // column inside main — that was the two-rail bug the mockup only ever
    // showed one column for.
    expect(main.querySelector("[data-compile-receipt]")).toBeNull();
    expect(main.querySelector(".dashboard-rail")).toBeNull();
  });
});
