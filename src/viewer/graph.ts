/**
 * Graph data builder for the viewer's `#/graph` route.
 *
 * Converts the flat `ViewerPage[]` list from the startup snapshot into an
 * adjacency representation suitable for D3 force-directed rendering. Called
 * once by `buildViewerSnapshot` — the result is frozen in the snapshot and
 * served directly by `/api/graph` with no per-request computation.
 */

import type { ViewerPage } from "./types.js";
import type { GraphData, GraphEdge, GraphNode, GraphNodeId, PageId } from "./types.js";
import type { EntityId } from "../profile/types.js";

const DEFAULT_KIND = "concept";

/**
 * Wikilink edge with CONCRETE `PageId` endpoints — the shape every wikilink and
 * dangling-target edge takes. A subtype of the public {@link GraphEdge} (whose
 * endpoints are widened to {@link GraphNodeId} for typed relation edges), so the
 * wikilink builders stay `PageId`-keyed and the default path never touches an
 * `EntityId`. Assignable to `GraphEdge[]` at the construction boundary.
 */
interface WikilinkEdge {
  source: PageId;
  target: PageId;
}

/**
 * Minimal typed-entity-page input for {@link buildGraphData}: just the identity
 * (`id`/`slug`/`directory`) plus the declared `entityType` and optional display
 * `title`. A trimmed shape (not the full collector `EntityPage`) so the graph
 * builder stays decoupled from frontmatter/body and the call site can pass a
 * cheap projection.
 */
export interface EntityPageNode {
  /** Branded `<entityType>/<slug>` identity; the node's key. */
  id: EntityId;
  /** Declared profile entity type, e.g. `"person"`. */
  entityType: string;
  /** Validated filename stem. */
  slug: string;
  /** Source directory the entity page lives in. */
  directory: string;
  /** Display title; falls back to `slug` when absent. */
  title?: string;
}

/**
 * Minimal typed-relation input for {@link buildGraphData}: the relation `type`
 * plus its two entity endpoints. Becomes one directed edge (`from`→`to`) tagged
 * with `edgeKind: "relation"` / `relationType`. The optional `direction` field
 * comes from the profile's relation-type def and is carried through to the edge
 * so the client can distinguish symmetric (undirected) from directed edges.
 */
export interface RelationEdge {
  /** Relation-type id (a key of `profile.relations`). */
  type: string;
  /** `from` endpoint entity id. */
  from: EntityId;
  /** `to` endpoint entity id. */
  to: EntityId;
  /** Relation-type directionality from the profile def (additive; absent → client treats as directed). */
  direction?: "directed" | "symmetric";
}

/**
 * Optional, ADDITIVE typed-graph inputs. When ABSENT or empty (every default
 * project, and every relation/entity-less profile) {@link buildGraphData}
 * returns output byte-identical to the wikilink-only graph — no typed nodes or
 * edges are appended and no existing node/edge field is perturbed.
 */
export interface GraphBuildOptions {
  /** Typed entity pages to surface as nodes (CLP 4b). */
  entityPages?: EntityPageNode[];
  /** Typed relations to surface as edges (CLP 4b). */
  relations?: RelationEdge[];
}

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
 *
 * CLP 4b: `opts` ADDITIVELY surfaces typed entity pages (as nodes keyed by
 * their `EntityId`, tagged with `nodeKind: "entity"` + `entityType`) and typed
 * relations (as edges tagged with `edgeKind: "relation"` + `relationType`).
 * Typed nodes are appended AFTER the real+ghost wikilink nodes, sorted by
 * `EntityId` for rank-stable ordering; relation edges are appended AFTER the
 * wikilink edges. A relation endpoint with no backing entity node and no page
 * becomes a ghost node so a dangling relation can never break expansion. When
 * `opts` is absent/empty the output is byte-identical to the wikilink-only
 * graph (no field on an existing node/edge is touched).
 */
export function buildGraphData(pages: ViewerPage[], opts?: GraphBuildOptions): GraphData {
  const pageIds = new Set<PageId>(pages.map((p) => p.id));
  const edges = buildEdges(pages);
  const ghostDisplayMap = buildGhostDisplayMap(pages);
  const inDegreeMap = buildInDegreeMap(edges);
  const realNodes = pages.map((p) => buildNode(p, pageIds, inDegreeMap));
  const ghostNodes = buildGhostNodes(edges, pageIds, inDegreeMap, ghostDisplayMap);
  const base: GraphData = { nodes: [...realNodes, ...ghostNodes], edges };
  return appendTypedGraph(base, pageIds, opts);
}

/**
 * Append typed entity nodes + relation edges to the wikilink-only `base`,
 * additively. Returns `base` UNCHANGED (same object, byte-identical) when no
 * typed inputs are present. Relation endpoints with no backing entity node and
 * no page become ghost nodes so a dangling relation stays expansion-safe.
 */
function appendTypedGraph(
  base: GraphData,
  pageIds: ReadonlySet<PageId>,
  opts?: GraphBuildOptions,
): GraphData {
  const entityPages = opts?.entityPages ?? [];
  const relations = opts?.relations ?? [];
  if (entityPages.length === 0 && relations.length === 0) return base;
  const relationDegree = buildRelationDegreeMap(relations);
  const entityNodes = buildEntityNodes(entityPages, relationDegree);
  const relationEdges = buildRelationEdges(relations);
  const knownIds = collectKnownNodeIds(pageIds, base.nodes, entityNodes);
  const relationGhosts = buildRelationGhostNodes(relations, knownIds, relationDegree);
  return {
    nodes: [...base.nodes, ...entityNodes, ...relationGhosts],
    edges: [...base.edges, ...relationEdges],
  };
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

function buildEdges(pages: ViewerPage[]): WikilinkEdge[] {
  const edges: WikilinkEdge[] = [];
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
  edges: WikilinkEdge[],
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

function buildInDegreeMap(edges: WikilinkEdge[]): Map<PageId, number> {
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

/** Tally every relation's incident degree per endpoint id (both `from` and `to`). */
function buildRelationDegreeMap(relations: RelationEdge[]): Map<GraphNodeId, number> {
  const map = new Map<GraphNodeId, number>();
  for (const rel of relations) {
    map.set(rel.from, (map.get(rel.from) ?? 0) + 1);
    map.set(rel.to, (map.get(rel.to) ?? 0) + 1);
  }
  return map;
}

/**
 * Build one typed entity node per entity page, sorted by `EntityId` so the
 * appended block has a deterministic, rank-stable order independent of the
 * collector's iteration order. Degree comes only from relation edges, so it
 * cannot perturb wikilink-node degree. `kind` carries the `entityType` and the
 * `nodeKind`/`entityType` discriminators mark it as typed.
 */
function buildEntityNodes(
  entityPages: EntityPageNode[],
  relationDegree: ReadonlyMap<GraphNodeId, number>,
): GraphNode[] {
  return [...entityPages]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((page) => ({
      id: page.id,
      title: page.title ?? page.slug,
      slug: page.slug,
      directory: page.directory,
      kind: page.entityType,
      degree: relationDegree.get(page.id) ?? 0,
      nodeKind: "entity" as const,
      entityType: page.entityType,
    }));
}

/** Map each relation to one relation-tagged edge (`from`→`to`), carrying direction when supplied. */
function buildRelationEdges(relations: RelationEdge[]): GraphEdge[] {
  return relations.map((rel) => ({
    source: rel.from,
    target: rel.to,
    edgeKind: "relation" as const,
    relationType: rel.type,
    ...(rel.direction !== undefined ? { direction: rel.direction } : {}),
  }));
}

/** Collect every id that already has a backing node (pages, ghosts, entity nodes). */
function collectKnownNodeIds(
  pageIds: ReadonlySet<PageId>,
  baseNodes: GraphNode[],
  entityNodes: GraphNode[],
): Set<GraphNodeId> {
  const known = new Set<GraphNodeId>(pageIds);
  for (const node of baseNodes) known.add(node.id);
  for (const node of entityNodes) known.add(node.id);
  return known;
}

/**
 * Synthesise a ghost node for any relation endpoint with no backing entity node
 * and no page — reusing the `isDangling` ghost mechanism so a dangling relation
 * appears as a broken target rather than breaking expansion. Deterministic
 * order: sorted by id, first-seen deduped. Directory/slug are derived from the
 * `<entityType>/<slug>` endpoint shape.
 */
function buildRelationGhostNodes(
  relations: RelationEdge[],
  knownIds: ReadonlySet<GraphNodeId>,
  relationDegree: ReadonlyMap<GraphNodeId, number>,
): GraphNode[] {
  const missing = new Set<GraphNodeId>();
  for (const rel of relations) {
    if (!knownIds.has(rel.from)) missing.add(rel.from);
    if (!knownIds.has(rel.to)) missing.add(rel.to);
  }
  return [...missing].sort((a, b) => a.localeCompare(b)).map((id) => {
    const [directory, ...rest] = id.split("/");
    const slug = rest.join("/");
    return {
      id,
      title: slug,
      slug,
      directory,
      kind: "dangling",
      degree: relationDegree.get(id) ?? 0,
      isDangling: true,
    };
  });
}
