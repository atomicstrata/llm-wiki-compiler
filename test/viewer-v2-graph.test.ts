/**
 * The v2 graph: the pure rules (colour, size, link target, tooltip text,
 * framing) and the static markup of the legend, the empty state, the drawing,
 * and the Fit controls before any layout has run.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphNode } from "../viewer-v2/src/api.js";
import { GraphLegend, GraphSurface } from "../viewer-v2/src/graph-canvas.js";
import { forcesFor, frameFor, KIND_COLOR, nodeHref, nodeKind, nodeMeta, nodeRadius, staleIds } from "../viewer-v2/src/graph-model.js";
import { GraphView } from "../viewer-v2/src/graph-view.js";
import { envelope, page } from "./fixtures/viewer-v2-fixtures.js";

/** A default page node; override any field. */
function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return { id: "concepts/alpha", title: "Alpha", slug: "alpha", directory: "concepts", kind: "concept", degree: 1, ...overrides };
}

const ENTITY = node({ id: "articles/deal", slug: "deal", directory: "wiki/articles", kind: "article", nodeKind: "entity", entityType: "articles", degree: 3 });
const GHOST = node({ id: "concepts/missing", slug: "missing", kind: "dangling", isDangling: true, degree: 2 });
const WIKI = envelope({
  pages: [page({ id: "concepts/alpha", freshness: { freshnessStatus: "stale", contradicted: false, archived: false } }), page({ id: "concepts/beta", freshness: { freshnessStatus: "orphaned", contradicted: false, archived: false } })],
});

describe("graph model", () => {
  it("colours a ghost before a stale page before its kind", () => {
    const stale = staleIds(WIKI);
    expect([...stale]).toEqual(["concepts/alpha"]);
    expect(nodeKind(node(), stale)).toBe("stale");
    expect(nodeKind(node({ id: "concepts/beta" }), stale)).toBe("concept");
    expect(nodeKind(ENTITY, stale)).toBe("entity");
    expect(nodeKind({ ...ENTITY, id: "concepts/alpha" }, stale)).toBe("stale");
    expect(nodeKind({ ...GHOST, id: "concepts/alpha" }, stale)).toBe("dangling");
  });

  it("sizes by degree within each mode's bounds", () => {
    expect(nodeRadius(0, 0, false)).toBe(4);
    expect(nodeRadius(5, 10, false)).toBe(7);
    expect(nodeRadius(10, 10, true)).toBe(6);
    expect(nodeRadius(0, 10, true)).toBe(2.5);
  });

  it("links a default page by directory, an entity by type, and a ghost nowhere", () => {
    expect(nodeHref(node())).toBe("#/concepts/alpha");
    expect(nodeHref(ENTITY)).toBe("#/articles/deal");
    expect(nodeHref(GHOST)).toBeNull();
  });

  it("describes a node for the tooltip", () => {
    expect(nodeMeta(node())).toBe("concept · 1 connection");
    expect(nodeMeta(ENTITY)).toBe("entity · articles · 3 connections");
    expect(nodeMeta(GHOST)).toBe("missing page · 2 references");
  });

  it("frames the layout with padding and never past the zoom limit", () => {
    const spread = frameFor([{ x: 0, y: 0 }, { x: 100, y: 50 }], 264, 164);
    expect(spread.k).toBe(2);
    expect(spread).toEqual({ k: 2, x: 32, y: 32 });
    const single = frameFor([{ x: 10, y: 10 }], 800, 600);
    expect(single.k).toBe(4);
    expect(single).toEqual({ k: 4, x: 360, y: 260 });
  });

  it("keeps the explorer's forces fixed and derives the panel's from its size", () => {
    expect(forcesFor(false, 10, 10, 500)).toEqual({ linkDistance: 80, charge: -200 });
    const reference = forcesFor(true, 128, 128, 1);
    expect(reference.linkDistance).toBeCloseTo(128 * 1.39);
    expect(reference.charge).toBeCloseTo(-128 * 4.69);
    expect(forcesFor(true, 128, 128, 64).linkDistance).toBeLessThan(reference.linkDistance / 8);
  });
});

describe("graph markup", () => {
  it("lists every node kind, both edge kinds, and the size rule in the full legend", () => {
    const html = renderToStaticMarkup(createElement(GraphLegend, {}));
    for (const kind of ["concept", "entity", "stale", "dangling"] as const) {
      expect(html).toContain(`<span class="${KIND_COLOR[kind]}" aria-hidden="true">●</span>${kind}`);
    }
    expect(html).toContain("─ wikilink");
    expect(html).toContain("╌ relation");
    expect(html).toContain("larger = more connections");
  });

  it("shows the empty state when the graph has no nodes", () => {
    const html = renderToStaticMarkup(createElement(GraphSurface, { data: { nodes: [], edges: [] }, stale: new Set<string>(), compact: true }));
    expect(html).toContain("Nothing to graph yet");
    expect(html).not.toContain("<svg");
  });

  it("draws every node with its colour class and link, hidden until the layout settles", () => {
    const data = { nodes: [node(), ENTITY, GHOST], edges: [{ source: "concepts/alpha", target: "concepts/missing" }, { source: "articles/deal", target: "concepts/alpha", edgeKind: "relation" as const, relationType: "mentions", direction: "symmetric" as const }] };
    const html = renderToStaticMarkup(createElement(GraphSurface, { data, stale: staleIds(WIKI), compact: false }));
    expect(html).toContain("Arranging graph…");
    expect(html).toContain('data-settled="false"');
    expect(html).toContain('href="#/concepts/alpha"');
    expect(html).toContain('href="#/articles/deal"');
    expect(html).not.toContain('href="#/concepts/missing"');
    expect(html).toContain(`<g data-node="" class="${KIND_COLOR.stale} transition-opacity">`);
    expect(html).toContain(`<g data-node="" class="${KIND_COLOR.entity} transition-opacity">`);
    expect(html).toContain('r="8" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-dasharray="3,2"');
    expect(html).toContain('<line stroke="currentColor" opacity="0.3" marker-end="url(#');
    expect(html).toContain('<line stroke="currentColor" opacity="0.3" stroke-dasharray="5 3"><title>mentions</title>');
  });

  it("keeps the explorer's Fit disabled until a layout reports back", () => {
    const explorer = renderToStaticMarkup(createElement(GraphView, { wiki: envelope({ graph: { nodeCount: 3, edgeCount: 2, danglingCount: 1 } }) }));
    expect(explorer).toContain("Graph explorer");
    expect(explorer).toContain("3 nodes · 2 edges · ");
    expect(explorer).toMatch(/disabled=""[^>]*>Fit<\/button>/);
    expect(explorer).toContain("Loading…");
  });
});
