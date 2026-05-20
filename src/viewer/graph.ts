/**
 * Graph data builder for the viewer's `#/graph` route.
 *
 * Converts the flat `ViewerPage[]` list from the startup snapshot into an
 * adjacency representation suitable for D3 force-directed rendering. Called
 * once by `buildViewerSnapshot` — the result is frozen in the snapshot and
 * served directly by `/api/graph` with no per-request computation.
 */

import type { ViewerPage } from "./types.js";
import type { GraphData, GraphEdge, GraphNode, PageId } from "./types.js";

const DEFAULT_KIND = "concept";

/** Resolve the display kind for a page, defaulting to "concept" when absent or non-string. */
export function resolvePageKind(frontmatter: Record<string, unknown>): string {
  return typeof frontmatter.kind === "string" && frontmatter.kind.length > 0
    ? frontmatter.kind
    : DEFAULT_KIND;
}

/**
 * Build graph adjacency data from the page list. All outgoing links become
 * edges — including dangling ones whose target has no backing page. Dangling
 * targets appear as ghost nodes with `isDangling: true`. Real-node degree
 * counts only valid edges (dangling out-links do not inflate the source
 * node's out-degree).
 */
export function buildGraphData(pages: ViewerPage[]): GraphData {
  const pageIds = new Set<PageId>(pages.map((p) => p.id));
  const edges = buildEdges(pages);
  const ghostDisplayMap = buildGhostDisplayMap(pages);
  const inDegreeMap = buildInDegreeMap(edges);
  const realNodes = pages.map((p) => buildNode(p, pageIds, inDegreeMap));
  const ghostNodes = buildGhostNodes(edges, pageIds, inDegreeMap, ghostDisplayMap);
  return { nodes: [...realNodes, ...ghostNodes], edges };
}

function buildGhostDisplayMap(pages: ViewerPage[]): Map<PageId, string> {
  const map = new Map<PageId, string>();
  for (const page of pages) {
    for (const { slug, display } of page.danglingLinks ?? []) {
      const id = ghostId(slug);
      if (!map.has(id)) map.set(id, display);
    }
  }
  return map;
}

const GHOST_DIRECTORY = "concepts";

/** Synthesise a stable PageId for an unresolved slug so ghost nodes have a unique key. */
function ghostId(slug: string): PageId {
  return `${GHOST_DIRECTORY}/${slug}` as PageId;
}

function buildEdges(pages: ViewerPage[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const page of pages) {
    for (const target of page.outgoingLinks) {
      edges.push({ source: page.id, target });
    }
    for (const { slug } of page.danglingLinks ?? []) {
      edges.push({ source: page.id, target: ghostId(slug) });
    }
  }
  return edges;
}

function buildGhostNodes(
  edges: GraphEdge[],
  pageIds: Set<PageId>,
  inDegreeMap: Map<PageId, number>,
  displayMap: Map<PageId, string>,
): GraphNode[] {
  const seen = new Set<PageId>();
  const ghosts: GraphNode[] = [];
  for (const { target } of edges) {
    if (pageIds.has(target) || seen.has(target)) continue;
    seen.add(target);
    const [directory, ...rest] = target.split("/");
    const slug = rest.join("/");
    ghosts.push({
      id: target,
      title: displayMap.get(target) ?? slug,
      slug,
      directory,
      kind: "dangling",
      degree: inDegreeMap.get(target) ?? 0,
      isDangling: true,
    });
  }
  return ghosts;
}

function buildInDegreeMap(edges: GraphEdge[]): Map<PageId, number> {
  const map = new Map<PageId, number>();
  for (const edge of edges) {
    map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
  }
  return map;
}

function buildNode(
  page: ViewerPage,
  pageIds: Set<PageId>,
  inDegreeMap: Map<PageId, number>,
): GraphNode {
  const outDegree = page.outgoingLinks.filter((t) => pageIds.has(t)).length;
  const inDegree = inDegreeMap.get(page.id) ?? 0;
  const kind = resolvePageKind(page.frontmatter);
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    directory: page.pageDirectory,
    kind,
    degree: outDegree + inDegree,
  };
}
