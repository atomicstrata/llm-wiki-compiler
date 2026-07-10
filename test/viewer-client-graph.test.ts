/**
 * DOM-level rendering tests for `src/viewer/assets/viewer-graph.js`.
 *
 * Evals the client module in a JSDOM window with module-scoped functions
 * exposed as globals, then asserts on coloring, tooltip, legend, and
 * edge style behavior. D3-dependent rendering (SVG simulation) is exercised
 * via a minimal stub; pure-DOM helpers (buildLegend, colorForNode, etc.)
 * are tested directly via the exposed globals.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { JSDOM } from "jsdom";

const GRAPH_SCRIPT = path.resolve("src/viewer/assets/viewer-graph.js");
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Eval viewer-graph.js in a JSDOM window, rewriting `export async function`
 * to a plain declaration and exposing module-scoped helpers on `window.__vg`.
 */
async function loadGraphHelpers(win: Window & typeof globalThis) {
  const src = await readFile(GRAPH_SCRIPT, "utf8");
  const rewritten =
    src.replace(/^export async function loadGraph\(/m, "async function loadGraph(") +
    `\nwindow.__vg = { colorForNode, restColorsForNode, paletteForNode, buildLegend, styleEdges, KIND_COLORS };\n`;
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

describe("viewer-graph.js — paletteForNode (entity node coloring)", () => {
  it("entity nodeKind returns entity palette, not concept fallback", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const kc = vg.KIND_COLORS as Record<string, { fill: string }>;
    // "experiments" is an entityType not in KIND_COLORS — with nodeKind:"entity" it routes to entity
    const result = (vg.paletteForNode as (k: string, nk?: string) => { fill: string })("experiments", "entity");
    expect(result.fill).toBe(kc.entity.fill);
    expect(result.fill).not.toBe(kc.concept.fill);
  });

  it("unknown kind without nodeKind falls back to concept palette", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const kc = vg.KIND_COLORS as Record<string, { fill: string }>;
    const result = (vg.paletteForNode as (k: string) => { fill: string })("unknown-kind");
    expect(result.fill).toBe(kc.concept.fill);
  });
});

describe("viewer-graph.js — restColorsForNode (entity resting color)", () => {
  it("entity nodeKind returns entity rest color, not concept rest color", async () => {
    const win = makeWindow();
    const vg = await loadGraphHelpers(win);
    const kc = vg.KIND_COLORS as Record<string, { rest: string }>;
    const result = (vg.restColorsForNode as (k: string, nk?: string) => { fill: string })("experiments", "entity");
    expect(result.fill).toBe(kc.entity.rest);
    expect(result.fill).not.toBe(kc.concept.rest);
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

  it("legend still contains all previous node kind entries", async () => {
    const labels = await renderLegendLabels();
    for (const kind of ["concept", "entity", "comparison", "overview", "orphan", "missing"]) {
      expect(labels).toContain(kind);
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

describe("viewer-graph.js — styleEdges (DOM marker-end + dashed relation stroke)", () => {
  it("symmetric edge has NO marker-end; directed relation + wikilink edges DO", async () => {
    const { symmetric, directed, wikilink } = await renderEdgeLines();
    expect(symmetric.getAttribute("marker-end")).toBeNull();
    expect(directed.getAttribute("marker-end")).toMatch(/^url\(#/);
    expect(wikilink.getAttribute("marker-end")).toMatch(/^url\(#/);
  });

  it("relation edges get the dashed stroke + relationType title; wikilink edge does not", async () => {
    const { symmetric, directed, wikilink } = await renderEdgeLines();
    expect(directed.getAttribute("stroke-dasharray")).toBe("5,3");
    expect(symmetric.getAttribute("title")).toBe("related");
    expect(directed.getAttribute("title")).toBe("tests");
    expect(wikilink.getAttribute("stroke-dasharray")).toBeNull();
    expect(wikilink.getAttribute("title")).toBeNull();
  });
});
