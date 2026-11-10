/**
 * DOM-level rendering tests for `src/viewer/assets/viewer-graph.js`.
 *
 * Evals the client module in a JSDOM window with module-scoped functions
 * exposed as globals, then asserts on class-based node/edge styling (colour
 * itself lives in viewer-graph.css — see viewer-graph-theming.test.ts), the
 * legend, and the client-side stale-id join. D3-dependent rendering (SVG
 * simulation) is exercised via a minimal stub; pure-DOM/pure-data helpers
 * (buildLegend, nodeClass, staleIdsFromEnvelope, styleEdges) are tested
 * directly via the exposed globals.
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";

const GRAPH_SCRIPT = path.resolve("src/viewer/assets/viewer-graph.js");
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Eval viewer-graph.js in a JSDOM window, rewriting its `export`
 * declarations (`loadGraph`, `staleIdsFromEnvelope`, `LEGEND_KINDS`) to
 * plain ones and exposing module-scoped helpers on `window.__vg`.
 *
 * The module's `import { emptyState } from "./viewer-dom.js";` line (added
 * for the design-system empty state) is dropped rather than rewired: this
 * raw `win.eval` has no module loader — unlike `mountViewerDom`'s
 * `rewriteImports`, which only runs for modules mounted through the JSDOM
 * harness — and none of the four functions under test here call `emptyState`.
 */
async function loadGraphHelpers(win: Window & typeof globalThis) {
  const src = await readFile(GRAPH_SCRIPT, "utf8");
  const rewritten =
    src
      .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;\s*$/gm, "")
      .replace(/^export async function loadGraph\(/m, "async function loadGraph(")
      .replace(/^export function staleIdsFromEnvelope\(/m, "function staleIdsFromEnvelope(")
      .replace(/^export const LEGEND_KINDS/m, "const LEGEND_KINDS") +
    `\nwindow.__vg = { nodeClass, staleIdsFromEnvelope, buildLegend, styleEdges, nodeRouteHash };\n`;
  win.eval(rewritten);
  return (win as unknown as Record<string, Record<string, unknown>>).__vg;
}

type EdgeDatum = Record<string, unknown>;
type AttrArg = ((d: EdgeDatum) => unknown) | unknown;

/**
 * A minimal d3-line-selection stub bound to `edges`: creates one real JSDOM
 * `<line>` per datum and, on each `.attr(name, valueOrFn)`, resolves the value
 * per datum (calling it if it's a function, mirroring d3) and applies it —
 * null clears the attribute. Lets `styleEdges` run its real attr-callbacks
 * against real DOM nodes.
 */
function makeEdgeSelection(doc: Document, edges: EdgeDatum[]) {
  const lines = edges.map(() => doc.createElementNS(SVG_NS, "line"));
  const selection = {
    attr(name: string, valueOrFn: AttrArg) {
      edges.forEach((d, i) => {
        const value = typeof valueOrFn === "function" ? valueOrFn(d) : valueOrFn;
        if (value === null) lines[i].removeAttribute(name);
        else lines[i].setAttribute(name, String(value));
      });
      return selection;
    },
  };
  return { selection, lines };
}

function makeWindow(): Window & typeof globalThis {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", {
    url: "http://localhost/", runScripts: "outside-only",
  });
  return dom.window as unknown as Window & typeof globalThis;
}

type NodeClassFn = (d: Record<string, unknown>, staleIds: Set<string>) => string;

describe("viewer-graph.js — nodeClass (node semantic class resolution)", () => {
  it("a dangling node is graph-node--dangling regardless of kind or staleness", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const nodeClass = vg.nodeClass as NodeClassFn;
    expect(nodeClass({ id: "concepts/a", isDangling: true }, new Set(["concepts/a"])))
      .toBe("graph-node graph-node--dangling");
    expect(nodeClass({ id: "concepts/b", kind: "dangling" }, new Set())).toBe("graph-node graph-node--dangling");
  });

  it("a stale id outranks nodeKind:entity — staleness is checked before entity", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const nodeClass = vg.nodeClass as NodeClassFn;
    const staleIds = new Set(["person/amy"]);
    expect(nodeClass({ id: "person/amy", nodeKind: "entity" }, staleIds)).toBe("graph-node graph-node--stale");
  });

  it("nodeKind:entity (not stale, not dangling) is graph-node--entity", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const nodeClass = vg.nodeClass as NodeClassFn;
    expect(nodeClass({ id: "person/amy", nodeKind: "entity" }, new Set())).toBe("graph-node graph-node--entity");
  });

  it("an ordinary wikilink node (not stale, no nodeKind) is graph-node--concept", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const nodeClass = vg.nodeClass as NodeClassFn;
    expect(nodeClass({ id: "concepts/a", kind: "concept" }, new Set())).toBe("graph-node graph-node--concept");
  });
});

type StaleIdsFn = (envelope: unknown) => Set<string>;

/** Build a minimal /api/pages-shaped envelope from freshnessStatus strings keyed by page id. */
function envelopeOf(statuses: Record<string, string>) {
  return {
    pages: Object.entries(statuses).map(([id, freshnessStatus]) => ({ id, freshness: { freshnessStatus } })),
  };
}

describe("viewer-graph.js — staleIdsFromEnvelope (client-side freshness join)", () => {
  // Compared via a sorted array, not `toEqual(new Set(...))`: the Set the eval'd
  // module returns is constructed in the JSDOM window's realm, and cross-realm
  // Set instances (structurally identical, different `Set` constructor) fail
  // the runner's deep-equal even though their contents match.
  it("collects only stale/orphaned page ids, skipping fresh/unverified", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const staleIdsFromEnvelope = vg.staleIdsFromEnvelope as StaleIdsFn;
    const envelope = envelopeOf({
      "concepts/a": "stale",
      "concepts/b": "orphaned",
      "concepts/c": "fresh",
      "concepts/d": "unverified",
    });
    expect([...staleIdsFromEnvelope(envelope)].sort()).toEqual(["concepts/a", "concepts/b"]);
  });

  it("returns an empty set when the envelope is missing or has no pages array", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const staleIdsFromEnvelope = vg.staleIdsFromEnvelope as StaleIdsFn;
    expect([...staleIdsFromEnvelope(undefined)]).toEqual([]);
    expect([...staleIdsFromEnvelope({})]).toEqual([]);
  });
});

/** Render the legend into a detached div and return its legend-item label strings. */
async function renderLegendLabels(): Promise<string[]> {
  const win = makeWindow();
  const vg = await loadGraphHelpers(win);
  const container = (win as unknown as { document: Document }).document.createElement("div");
  (vg.buildLegend as (c: HTMLElement) => void)(container as HTMLElement);
  const items = Array.from(container.querySelectorAll(".graph-legend-item"));
  return items.map((el) => el.textContent?.trim() ?? "");
}

describe("viewer-graph.js — buildLegend (legend entries)", () => {
  it("includes a 'relation' edge entry in the legend", async () => {
    expect(await renderLegendLabels()).toContain("relation");
  });

  it("shows exactly the four design-system node semantics, no legacy kinds", async () => {
    const labels = await renderLegendLabels();
    for (const kind of ["concept", "entity", "stale", "dangling"]) {
      expect(labels).toContain(kind);
    }
    for (const legacyKind of ["comparison", "overview", "orphan", "missing"]) {
      expect(labels).not.toContain(legacyKind);
    }
  });
});

/** Run the real `styleEdges` over symmetric/directed/wikilink edges; return the DOM `<line>`s. */
async function renderEdgeLines() {
  const win = makeWindow();
  const vg = await loadGraphHelpers(win);
  const doc = (win as unknown as { document: Document }).document;
  const edges: EdgeDatum[] = [
    { edgeKind: "relation", relationType: "related", direction: "symmetric" },
    { edgeKind: "relation", relationType: "tests", direction: "directed" },
    { source: "a", target: "b" }, // a plain wikilink edge (no edgeKind/direction)
  ];
  const { selection, lines } = makeEdgeSelection(doc, edges);
  (vg.styleEdges as (s: unknown) => void)(selection);
  return { symmetric: lines[0], directed: lines[1], wikilink: lines[2] };
}

describe("viewer-graph.js — styleEdges (DOM marker-end + relation class)", () => {
  it("symmetric edge has NO marker-end; directed relation + wikilink edges DO", async () => {
    const { symmetric, directed, wikilink } = await renderEdgeLines();
    expect(symmetric.getAttribute("marker-end")).toBeNull();
    expect(directed.getAttribute("marker-end")).toMatch(/^url\(#/);
    expect(wikilink.getAttribute("marker-end")).toMatch(/^url\(#/);
  });

  it("relation edges get the graph-edge--relation class + relationType title; wikilink edge does not", async () => {
    const { symmetric, directed, wikilink } = await renderEdgeLines();
    expect(directed.getAttribute("class")).toBe("graph-edge graph-edge--relation");
    expect(symmetric.getAttribute("title")).toBe("related");
    expect(directed.getAttribute("title")).toBe("tests");
    expect(wikilink.getAttribute("class")).toBe("graph-edge");
    expect(wikilink.getAttribute("title")).toBeNull();
  });
});

describe("nodeRouteHash", () => {
  /** Load the module and return its `nodeRouteHash` helper. */
  async function routeHash(): Promise<(node: Record<string, unknown>) => string | null> {
    const vg = await loadGraphHelpers(makeWindow());
    return vg.nodeRouteHash as (node: Record<string, unknown>) => string | null;
  }

  it("routes a typed entity node by its entity type, not its on-disk directory", async () => {
    // The regression: `directory` is "wiki/articles" for a typed node, and
    // encoding it produced #/wiki%2Farticles/<slug>, which the page route
    // answers 400 for. `id` already carries the route directory.
    const hash = (await routeHash())({
      id: "articles/harbour-lease-records",
      directory: "wiki/articles",
      slug: "harbour-lease-records",
    });
    expect(hash).toBe("#/articles/harbour-lease-records");
  });

  it("never emits an encoded separator in the directory segment", async () => {
    const hash = (await routeHash())({ id: "articles/x", directory: "wiki/articles", slug: "x" });
    expect(hash).not.toContain("%2F");
  });

  it("routes a default concept node unchanged", async () => {
    const hash = (await routeHash())({
      id: "concepts/change-detection",
      directory: "concepts",
      slug: "change-detection",
    });
    expect(hash).toBe("#/concepts/change-detection");
  });

  it("keeps a slug's own separator in the slug segment", async () => {
    // Split on the FIRST separator only — a dangling target's slug can contain one.
    expect((await routeHash())({ id: "concepts/a/b" })).toBe("#/concepts/a%2Fb");
  });

  it("percent-encodes a slug that needs it", async () => {
    expect((await routeHash())({ id: "concepts/a b" })).toBe("#/concepts/a%20b");
  });

  it("returns null for an id it cannot split", async () => {
    for (const id of ["", "concepts", "/x", "concepts/", undefined]) {
      expect((await routeHash())({ id })).toBeNull();
    }
  });
});
