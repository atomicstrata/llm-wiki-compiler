/**
 * Graph health evaluator for the llmwiki eval harness.
 *
 * Builds on the existing viewer graph path (collectViewerPages +
 * buildGraphData) so there is one source of truth for wikilink resolution,
 * ghost-node representation, and graph topology. All metrics are derived
 * from the viewer's immutable snapshot — no separate wikilink parser.
 *
 * Metrics:
 *  - unreferencedPages: real pages with indegree=0 (not dangling ghosts).
 *  - componentCount: weakly connected components over real pages.
 *  - avgIndegree: average indegree across real pages (real→real edges only).
 *  - hubPages: top 5 real pages by total degree (in + out), tie-broken by slug.
 *  - danglingCount: total number of ghost (unresolved) wikilink targets.
 *  - topDangling: up to 5 most-referenced dangling targets.
 */

import { collectViewerPages } from "../viewer/collect.js";
import { buildGraphData } from "../viewer/graph.js";
import type { ViewerPage, GraphData, GraphNode, GraphNodeId } from "../viewer/types.js";
import type { GraphHealthResult, HubPage } from "./types.js";



const MAX_HUB_PAGES = 5;
const MAX_TOP_DANGLING = 5;

/** Count indegree from real→real edges only (exclude edges involving ghosts). */
function buildRealIndegrees(realIds: Set<GraphNodeId>, edges: GraphData["edges"]): Map<GraphNodeId, number> {
  const map = new Map<GraphNodeId, number>();
  for (const e of edges) {
    if (realIds.has(e.source) && realIds.has(e.target)) {
      map.set(e.target, (map.get(e.target) ?? 0) + 1);
    }
  }
  return map;
}

/** Build undirected adjacency for real pages (real→real edges only, both directions). */
function buildUndirectedAdj(
  nodes: GraphNode[], edges: GraphData["edges"], realIds: Set<GraphNodeId>,
): Map<GraphNodeId, Set<GraphNodeId>> {
  const adj = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const n of nodes) {
    if (!n.isDangling) adj.set(n.id, new Set());
  }
  for (const e of edges) {
    if (realIds.has(e.source) && realIds.has(e.target)) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }
  }
  return adj;
}

/** BFS from a starting node, marking all reachable nodes as visited. */
function bfsFrom(start: GraphNodeId, adj: Map<GraphNodeId, Set<GraphNodeId>>, visited: Set<GraphNodeId>): void {
  const queue = [start];
  visited.add(start);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of adj.get(cur) ?? []) {
      if (!visited.has(n)) { visited.add(n); queue.push(n); }
    }
  }
}

/** Weakly connected components (undirected view over real pages). */
function countComponents(nodes: GraphNode[], edges: GraphData["edges"], realIds: Set<GraphNodeId>): number {
  const adj = buildUndirectedAdj(nodes, edges, realIds);
  const visited = new Set<GraphNodeId>();
  let components = 0;
  for (const id of adj.keys()) {
    if (!visited.has(id)) { components++; bfsFrom(id, adj, visited); }
  }
  return components;
}

/** Top dangling targets by indegree, using ghost nodes' pre-computed degrees. */
function topDanglingTargets(graph: GraphData): GraphHealthResult["topDangling"] {
  return graph.nodes
    .filter((n) => n.isDangling)
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, MAX_TOP_DANGLING)
    .map((n) => ({ id: n.id, title: n.title, referenceCount: n.degree }));
}

/**
 * Evaluate graph health for the current wiki.
 * Returns null when there are no wiki pages (graph not measurable).
 * @param root - Absolute path to the project root.
 */
export async function evaluateGraphHealth(
  root: string,
): Promise<GraphHealthResult | null> {
  const pages = await collectViewerPages(root);
  if (pages.length === 0) return null;

  const graph = buildGraphData(pages);
  const realNodes = graph.nodes.filter((n) => !n.isDangling);
  const realIds = new Set(realNodes.map((n) => n.id));

  const realIndegrees = buildRealIndegrees(realIds, graph.edges);
  const unreferenced = realNodes.filter((n) => (realIndegrees.get(n.id) ?? 0) === 0);

  const totalIndegree = [...realIndegrees.values()].reduce((s, v) => s + v, 0);
  const avgIndegree = realNodes.length > 0
    ? Math.round((totalIndegree / realNodes.length) * 100) / 100
    : 0;

  const realOutdegrees = new Map<GraphNodeId, number>();
  for (const e of graph.edges) {
    if (realIds.has(e.source) && realIds.has(e.target)) {
      realOutdegrees.set(e.source, (realOutdegrees.get(e.source) ?? 0) + 1);
    }
  }
  const hubPages: HubPage[] = realNodes
    .map((n) => {
      const indegree = realIndegrees.get(n.id) ?? 0;
      const outdegree = realOutdegrees.get(n.id) ?? 0;
      return { id: n.id, indegree, outdegree, totalDegree: indegree + outdegree };
    })
    .sort((a, b) => b.totalDegree - a.totalDegree || a.id.localeCompare(b.id))
    .slice(0, MAX_HUB_PAGES)
    .filter((h) => h.totalDegree > 0);

  const danglingNodes = graph.nodes.filter((n) => n.isDangling);

  return {
    pageCount: realNodes.length,
    unreferencedCount: unreferenced.length,
    unreferencedPages: unreferenced.map((n) => n.id),
    componentCount: countComponents(graph.nodes, graph.edges, realIds),
    avgIndegree,
    hubPages,
    danglingCount: danglingNodes.length,
    topDangling: topDanglingTargets(graph),
  };
}
