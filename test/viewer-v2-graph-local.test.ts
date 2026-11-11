/**
 * The v2 graph's structure helpers and their drawings: neighbours, the local
 * graph a page's rail draws, link communities and their colours, label
 * shortening, the explorer's find box lookup, and the rendered rail section
 * and community legend.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphEdge } from "../viewer-v2/src/api.js";
import { GraphLegend, GraphSurface, shortLabel } from "../viewer-v2/src/graph-canvas.js";
import { adjacency, communities, communityColor, COMMUNITY_COLORS, localGraph, UNCLUSTERED_COLOR } from "../viewer-v2/src/graph-neighbourhood.js";
import { zoomsOnGesture } from "../viewer-v2/src/graph-layout.js";
import { pageIdForTitle } from "../viewer-v2/src/graph-view.js";
import { NeighbourhoodSection } from "../viewer-v2/src/page-neighbourhood.js";
import { envelope, graph, page, text } from "./fixtures/viewer-v2-fixtures.js";

/** Undirected links between `a/b` pairs. */
function links(...pairs: [string, string][]): GraphEdge[] {
  return pairs.map(([source, target]) => ({ source, target }));
}

/** Two triangles joined by one bridge, and a loner. */
const TWO_CLUSTERS = graph(
  ["c/a1", "c/a2", "c/a3", "c/b1", "c/b2", "c/b3", "c/loner"],
  links(["c/a1", "c/a2"], ["c/a2", "c/a3"], ["c/a3", "c/a1"], ["c/b1", "c/b2"], ["c/b2", "c/b3"], ["c/b3", "c/b1"], ["c/a3", "c/b1"]),
);

describe("neighbours and local graphs", () => {
  it("finds neighbours in both directions, ignoring self-loops", () => {
    const data = graph(["c/x", "c/y", "c/z"], links(["c/x", "c/y"], ["c/z", "c/x"], ["c/x", "c/x"]));
    expect([...(adjacency(data).get("c/x") ?? [])].sort()).toEqual(["c/y", "c/z"]);
    expect(adjacency(data).get("c/missing")).toBeUndefined();
  });

  it("keeps the centre, its neighbours, then second-hop nodes up to the limit, with degrees counted inside", () => {
    const local = localGraph(TWO_CLUSTERS, "c/a1", 4);
    expect(local.nodes.map((node) => node.id).sort()).toEqual(["c/a1", "c/a2", "c/a3", "c/b1"]);
    expect(local.edges).toHaveLength(4);
    expect(local.nodes.find((node) => node.id === "c/b1")?.degree).toBe(1);
    expect(localGraph(TWO_CLUSTERS, "c/nope")).toEqual({ nodes: [], edges: [] });
  });
});

describe("communities", () => {
  it("splits two bridged triangles, leaves a loner unclustered, and is stable", () => {
    const ranks = communities(TWO_CLUSTERS);
    expect(ranks.get("c/a1")).toBe(ranks.get("c/a2"));
    expect(ranks.get("c/b2")).toBe(ranks.get("c/b3"));
    expect(ranks.get("c/a1")).not.toBe(ranks.get("c/b2"));
    expect(ranks.get("c/loner")).toBe(-1);
    expect(communities(TWO_CLUSTERS)).toEqual(ranks);
  });

  it("cycles colours through the communities and greys loners", () => {
    expect(communityColor(0)).toBe(COMMUNITY_COLORS[0]);
    expect(communityColor(-1)).toBe(UNCLUSTERED_COLOR);
    expect(communityColor(COMMUNITY_COLORS.length + 1)).toBe(COMMUNITY_COLORS[1]);
    expect(communityColor(undefined)).toBe(UNCLUSTERED_COLOR);
  });
});

describe("labels and lookup", () => {
  it("shortens long titles at a word", () => {
    expect(shortLabel("Short", 10)).toBe("Short");
    expect(shortLabel("Founder Separation Negotiations", 20)).toBe("Founder Separation…");
    expect(shortLabel("Supercalifragilistic", 8)).toBe("Superca…");
  });

  it("finds a page by its exact title, ignoring case", () => {
    const wiki = envelope({ pages: [page({ id: "concepts/kiln", title: "Kiln Firing Log" })] });
    expect(pageIdForTitle(wiki, "  kiln firing log ")).toBe("concepts/kiln");
    expect(pageIdForTitle(wiki, "Kiln")).toBeNull();
    expect(pageIdForTitle(wiki, "")).toBeNull();
  });
});

describe("zoom gestures", () => {
  it("lets the rail's small graph leave plain scrolling to the page", () => {
    expect(zoomsOnGesture(false, { type: "wheel" })).toBe(true);
    expect(zoomsOnGesture(true, { type: "wheel" })).toBe(false);
    expect(zoomsOnGesture(true, { type: "wheel", ctrlKey: true })).toBe(true);
    expect(zoomsOnGesture(true, { type: "touchstart", touches: { length: 1 } })).toBe(false);
    expect(zoomsOnGesture(true, { type: "touchstart", touches: { length: 2 } })).toBe(true);
    expect(zoomsOnGesture(true, { type: "mousedown" })).toBe(true);
  });
});

describe("drawings", () => {
  it("rings and labels the rail's centre page, and says when a page has no links", () => {
    const html = renderToStaticMarkup(createElement(GraphSurface, { data: TWO_CLUSTERS, stale: new Set<string>(), compact: true, centreId: "c/a1" }));
    expect(html).toMatch(/<circle r="[\d.]+" fill="none" stroke="currentColor" stroke-width="1.5">/);
    expect(html).toMatch(/<text[^>]*class="[^"]*"[^>]*>A1<\/text>/);
    const wiki = envelope({ pages: [] });
    const lonely = renderToStaticMarkup(createElement(NeighbourhoodSection, { pageId: "c/loner", wiki, graph: { status: "ready", data: TWO_CLUSTERS } }));
    expect(text(lonely)).toBe("Neighbourhood No links to or from this page yet.");
  });

  it("explains community colours in the legend", () => {
    expect(text(renderToStaticMarkup(createElement(GraphLegend, { colorBy: "community" })))).toContain("Each colour marks a cluster");
  });
});
