/**
 * @file src/viewer/navigation-artifacts.ts
 * @description The derived navigation artifacts AS-1 §4.9 `visualize`
 * regenerates: an Obsidian graph configuration carrying one colour group per
 * declared entity type, and a Canvas document whose edges are LABELLED with the
 * relation type they represent.
 *
 * GENERIC, NOT PRODUCT-SHAPED. Every group and every label is derived from the
 * PROFILE's declared entity and relation types, so a research wiki, a newsroom,
 * or anything else gets its own colours and labels without this module knowing
 * what any of them are. There is no product branch here and there must never be
 * one.
 *
 * IT DELIBERATELY BYPASSES `src/export/`. That subsystem's `ExportTarget` is a
 * CLOSED union dispatched exhaustively, so adding targets to it would be a core
 * change every profile pays for, to serve two formats that are really wiki-tree
 * artifacts rather than exports. These emit under the wiki tree instead —
 * exactly where the tools that read them look.
 *
 * PURE. Every function here maps data to data; writing is the caller's job, so
 * the shapes can be asserted exactly without touching a filesystem, and the
 * never-overwrite rule lives at the one place that writes.
 */

import type { GraphData, GraphEdge, GraphNode } from "./types.js";

/** A deterministic palette; groups beyond it wrap rather than collide silently. */
const GROUP_COLORS = Object.freeze([
  "#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2", "#c026d3", "#65a30d",
]);

/** One Obsidian colour group: a query matching an entity type, and its colour. */
export interface ObsidianColorGroupV1 {
  readonly query: string;
  readonly color: { readonly a: number; readonly rgb: number };
}

/** The subset of Obsidian's graph configuration this emits. */
export interface ObsidianGraphConfigV1 {
  readonly colorGroups: readonly ObsidianColorGroupV1[];
}

/** One Canvas node, in the format Obsidian Canvas reads. */
export interface CanvasNodeV1 {
  readonly id: string;
  readonly type: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One Canvas edge, carrying the relation type as its visible label. */
export interface CanvasEdgeV1 {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly label: string;
}

/** A complete Canvas document. */
export interface CanvasDocumentV1 {
  readonly nodes: readonly CanvasNodeV1[];
  readonly edges: readonly CanvasEdgeV1[];
}

/** Obsidian encodes a colour as a packed 24-bit integer. */
function packColor(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

/**
 * One colour group per DECLARED entity type, in declaration order.
 *
 * Derived from the profile's declared types rather than from the types the
 * graph happens to contain: a kind with no pages yet still deserves a stable
 * colour, and deriving from present data would silently re-colour every group
 * the first time someone adds a page of a new kind.
 *
 * @param entityTypes - The profile's declared entity types, in declaration order.
 */
export function obsidianGraphConfig(entityTypes: readonly string[]): ObsidianGraphConfigV1 {
  return {
    colorGroups: entityTypes.map((entityType, index) => ({
      query: `path:wiki/${entityType}`,
      color: { a: 1, rgb: packColor(GROUP_COLORS[index % GROUP_COLORS.length]!) },
    })),
  };
}

/** Lay nodes out on a deterministic grid — no randomness, so output is stable. */
function nodePosition(index: number): { x: number; y: number } {
  const columns = 6;
  return { x: (index % columns) * 320, y: Math.floor(index / columns) * 200 };
}

/** The label one edge carries: its relation type, or nothing for a wikilink. */
function edgeLabel(edge: GraphEdge): string {
  return edge.relationType ?? "";
}

/**
 * Render one Canvas document from graph data.
 *
 * ONLY TYPED EDGES ARE LABELLED, and untyped wikilink edges are kept with an
 * empty label rather than dropped: a canvas that silently omitted them would
 * misrepresent the wiki's connectivity, which is the one thing a knowledge map
 * exists to show.
 *
 * @param graph - The profile-driven graph to render.
 */
export function canvasDocument(graph: GraphData): CanvasDocumentV1 {
  const nodes = graph.nodes.map((node, index) => ({
    id: node.id, type: "text" as const,
    text: `# ${node.title}\n\n${node.kind}`,
    ...nodePosition(index), width: 280, height: 140,
  }));
  const present = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    // A Canvas edge naming a node the document does not carry is unreadable to
    // the tool, so a dangling endpoint drops the EDGE rather than the document.
    .filter((edge) => present.has(edge.source) && present.has(edge.target))
    .map((edge, index) => ({
      id: `edge-${index}`, fromNode: edge.source, toNode: edge.target, label: edgeLabel(edge),
    }));
  return { nodes, edges };
}

/**
 * The subgraph within `depth` hops of `focus`, following edges in BOTH
 * directions.
 *
 * UNDIRECTED TRAVERSAL IS THE POINT of a focus view: an operator asking what
 * surrounds a paper wants the works it cites AND the works citing it, and
 * following only the declared direction would silently halve the neighbourhood.
 *
 * @param graph - The full graph.
 * @param focus - The node id to centre on.
 * @param depth - Maximum hops; `0` yields the focus node alone.
 */
export function focusSubgraph(graph: GraphData, focus: string, depth: number): GraphData {
  const byId = new Map(graph.nodes.map((node) => [node.id as string, node]));
  if (!byId.has(focus)) return { nodes: [], edges: [] };
  const reached = new Set<string>([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      const step = adjacentTo(edge, frontier);
      for (const id of step) {
        if (!reached.has(id) && byId.has(id)) { reached.add(id); next.push(id); }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return {
    nodes: graph.nodes.filter((node) => reached.has(node.id as string)) as GraphNode[],
    edges: graph.edges.filter((edge) =>
      reached.has(edge.source as string) && reached.has(edge.target as string)) as GraphEdge[],
  };
}

/** The endpoints one edge reaches from any node in `frontier`, either way. */
function adjacentTo(edge: GraphEdge, frontier: readonly string[]): string[] {
  const source = edge.source as string;
  const target = edge.target as string;
  const found: string[] = [];
  if (frontier.includes(source)) found.push(target);
  if (frontier.includes(target)) found.push(source);
  return found;
}
