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
import type { ViewerPage, GraphData, GraphNode, PageId } from "../viewer/types.js";
import type { GraphHealthResult, HubPage } from "./types.js";



const MAX_HUB_PAGES = 5;
const MAX_TOP_DANGLING = 5;

/** Count indegree from real→real edges only (exclude edges involving ghosts). */
function buildRealIndegrees(realIds: Set<PageId>, edges: GraphData["edges"]): Map<PageId, number> {
  const map = new Map<PageId, number>();
  for (const e of edges) {
    if (realIds.has(e.source) && realIds.has(e.target)) {
      map.set(e.target, (map.get(e.target) ?? 0) + 1);
    }
  }
  return map;
}

/** Weakly connected components (BFS over undirected real→real edges). */
function countComponents(nodes: GraphNode[], edges: GraphData["edges"], realIds: Set<PageId>): number {
  const adj = new Map<PageId, Set<PageId>>();
  for (const n of nodes) {
    if (!n.isDangling) adj.set(n.id, new Set());
  }
  for (const e of edges) {
    if (realIds.has(e.source) && realIds.has(e.target)) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }
  }
  const visited = new Set<PageId>();
  let components = 0;
  for (const id of adj.keys()) {
    if (visited.has(id)) continue;
    components++;
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const n of adj.get(cur) ?? []) {
        if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
    }
  }
  return components;
}

/** Compute top dangling targets by indegree from real pages. */
function topDanglingTargets(
  nodes: GraphNode[], edges: GraphData["edges"], realIds: Set<PageId>,
): GraphHealthResult["topDangling"] {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const target = nodes.find((n) => n.id === e.target);
    if (target?.isDangling && realIds.has(e.source)) {
      counts.set(target.title, (counts.get(target.title) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOP_DANGLING)
    .map(([title, count]) => ({ title, referenceCount: count }));
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

  const hubPages: HubPage[] = realNodes
    .map((n) => {
      const indegree = realIndegrees.get(n.id) ?? 0;
      const outdegree = graph.edges.filter((e) => e.source === n.id && realIds.has(e.target)).length;
      return { slug: n.slug, indegree, outdegree, totalDegree: indegree + outdegree };
    })
    .sort((a, b) => b.totalDegree - a.totalDegree || a.slug.localeCompare(b.slug))
    .slice(0, MAX_HUB_PAGES)
    .filter((h) => h.totalDegree > 0);

  const danglingNodes = graph.nodes.filter((n) => n.isDangling);

  return {
    pageCount: realNodes.length,
    unreferencedCount: unreferenced.length,
    unreferencedPages: unreferenced.map((n) => n.slug),
    componentCount: countComponents(graph.nodes, graph.edges, realIds),
    avgIndegree,
    hubPages,
    danglingCount: danglingNodes.length,
    topDangling: topDanglingTargets(graph.nodes, graph.edges, realIds),
  };
}
