/**
 * Graph neighborhood expansion for `llmwiki context` Slice 3.
 *
 * Pure function over `ViewerSnapshot.graph` (built once at snapshot
 * time by `src/viewer/graph.ts::buildGraphData`) plus the orchestrator's
 * resolved primary IDs. Returns the documented `neighbors[]` and
 * `gaps[]` arrays without rebuilding adjacency from disk and without
 * touching the embeddings store.
 *
 * Topology rules pinned by the implementation plan §Graph Expansion:
 *   - real-page-only neighbors (ghosts go to `gaps[]` instead, with
 *     `code: "dangling-link"` and `pageId` set to the page that linked
 *     to the missing target)
 *   - primary pages never appear in `neighbors[]`
 *   - bidirectional edges (A->B and B->A) collapse to a single neighbor
 *     entry via the canonical unordered key `(min(a,b), max(a,b))`
 *   - depth 1 expands directly from each primary page
 *   - depth 2 expands from surviving depth-1 real neighbors, skipping
 *     primary back-edges and pages already at depth 1; cycles are
 *     blocked by a visited set
 *   - `--no-neighbors` and `--depth 0` produce empty `neighbors` /
 *     `gaps` arrays without crashing
 *
 * Scores are deterministic and normalized into [0, 1]; direct neighbors
 * outrank second-hop, and pages with multiple primary connections get
 * a small additive bonus. Stable tie-sort: descending score, then
 * ascending `to` page id (Slice 3 does not have neighbor titles handy
 * without an extra lookup, and id is already monotonic per directory).
 */

import type {
  GraphData,
  GraphNode,
  PageId,
  ViewerPage,
} from "../viewer/types.js";

/** Closed v1 neighbor edge label. */
const NEIGHBOR_REASON_WIKILINK = "wikilink";

/** Base score for a direct (depth-1) neighbor edge. */
const WEIGHT_NEIGHBOR_DIRECT = 0.5;

/** Base score for a second-hop (depth-2) neighbor edge. */
const WEIGHT_NEIGHBOR_SECOND_HOP = 0.25;

/**
 * Additive bonus per additional primary connection beyond the first
 * (capped). Keeps centrally-linked neighbors above peripherally-linked
 * ones without letting a "popular" page accumulate unbounded weight.
 */
const WEIGHT_PRIMARY_CONNECTION_BONUS = 0.05;
const MAX_PRIMARY_CONNECTION_BONUS_HITS = 3;

/** Cap so combined scores stay inside the normalized [0, 1] range. */
const MAX_NORMALIZED_SCORE = 1;

/** Reasons set on emitted neighbor entries. Closed v1 enum. */
type NeighborReason = typeof NEIGHBOR_REASON_WIKILINK;

/** Direction of the underlying wikilink relative to `from`. */
type NeighborDirection = "outgoing" | "incoming";

/** One neighbor entry in the v1 context-pack envelope. */
interface GraphNeighbor {
  from: PageId;
  to: PageId;
  direction: NeighborDirection;
  distance: number;
  score: number;
  reason: NeighborReason;
}

/** Gap entry surfaced when a primary page links to a missing target. */
interface GraphGap {
  code: "dangling-link";
  message: string;
  pageId: PageId;
}

/** Output of {@link expandGraphNeighborhood}. */
export interface GraphExpansionOutput {
  neighbors: GraphNeighbor[];
  gaps: GraphGap[];
}

/** Inputs grouped to keep argument lists short. */
interface GraphExpansionInput {
  graph: GraphData;
  pages: ViewerPage[];
  primaryIds: ReadonlySet<PageId>;
  /** 0 = expansion off; 1 = direct only; 2 = direct + second-hop. */
  depth: number;
}

/**
 * Expand `primaryIds` into the documented `{ neighbors, gaps }` shape.
 * Returns empty arrays — never `undefined`/`null` — so the orchestrator
 * can splice the result into the JSON envelope unconditionally.
 */
export function expandGraphNeighborhood(
  input: GraphExpansionInput,
): GraphExpansionOutput {
  // Depth 0 OR no primary IDs: both `neighbors[]` and `gaps[]` stay
  // empty (plan §CLI Acceptance Criteria). `--no-neighbors` short-
  // circuits before this function is called; this branch covers
  // `--depth 0` and the empty-wiki path.
  if (input.depth <= 0 || input.primaryIds.size === 0) {
    return { neighbors: [], gaps: [] };
  }
  const adjacency = buildAdjacency(input.graph);
  const ghostIds = collectGhostIds(input.graph.nodes);
  const depth1 = expandDepthOne({
    primaryIds: input.primaryIds,
    adjacency,
    ghostIds,
  });
  const depth2 = input.depth >= 2
    ? expandDepthTwo({
        primaryIds: input.primaryIds,
        adjacency,
        ghostIds,
        depthOneTargets: collectDepthOneTargets(depth1),
      })
    : [];
  const neighbors = [...depth1, ...depth2].sort(compareNeighbors);
  return { neighbors, gaps: emitGapsFromPrimary(input) };
}

/** Surface dangling-link gaps for every primary page that owns one. */
function emitGapsFromPrimary(input: GraphExpansionInput): GraphGap[] {
  const gaps: GraphGap[] = [];
  for (const page of input.pages) {
    if (!input.primaryIds.has(page.id)) continue;
    for (const dangling of page.danglingLinks ?? []) {
      gaps.push({
        code: "dangling-link",
        message: `Page links to [[${dangling.display}]], but no page exists.`,
        pageId: page.id,
      });
    }
  }
  return gaps;
}

/** Outgoing + incoming edge maps for fast neighbor lookup keyed by PageId. */
interface Adjacency {
  outgoing: Map<PageId, Set<PageId>>;
  incoming: Map<PageId, Set<PageId>>;
}

/** Build the bidirectional adjacency from the snapshot's edge list. */
function buildAdjacency(graph: GraphData): Adjacency {
  const outgoing = new Map<PageId, Set<PageId>>();
  const incoming = new Map<PageId, Set<PageId>>();
  for (const edge of graph.edges) {
    addToSetMap(outgoing, edge.source, edge.target);
    addToSetMap(incoming, edge.target, edge.source);
  }
  return { outgoing, incoming };
}

/** Insert `value` into the set at `key`, creating the set on first use. */
function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

/** Collect every ghost-node id so we can drop dangling targets from neighbors. */
function collectGhostIds(nodes: GraphNode[]): Set<PageId> {
  const ghosts = new Set<PageId>();
  for (const node of nodes) if (node.isDangling) ghosts.add(node.id);
  return ghosts;
}

/** Shared input for the depth-1 expansion path. */
interface DepthOneInput {
  primaryIds: ReadonlySet<PageId>;
  adjacency: Adjacency;
  ghostIds: ReadonlySet<PageId>;
}

/**
 * Depth-1 expansion: for each primary page, walk outgoing + incoming
 * edges and emit one entry per real-page neighbor. Bidirectional
 * duplicates collapse via the canonical-pair key.
 */
function expandDepthOne(input: DepthOneInput): GraphNeighbor[] {
  const emitted = new Map<string, GraphNeighbor>();
  const connectionCount = new Map<PageId, number>();
  for (const primary of input.primaryIds) {
    addNeighborsForPrimary({ ...input, primary, emitted, connectionCount });
  }
  applyPrimaryConnectionBonus(emitted, connectionCount);
  return Array.from(emitted.values());
}

/** Helpers passed into the per-primary depth-1 walker. */
interface DepthOnePerPrimary extends DepthOneInput {
  primary: PageId;
  emitted: Map<string, GraphNeighbor>;
  connectionCount: Map<PageId, number>;
}

/** Walk every edge incident to one primary page and emit canonicalized neighbors. */
function addNeighborsForPrimary(ctx: DepthOnePerPrimary): void {
  walkIncidentEdges(ctx.adjacency, ctx.primary, (other, direction) => {
    tryEmitDirect({ ctx, other, direction });
  });
}

/** Inputs for the per-edge depth-1 emission check. */
interface EmitDirectInput {
  ctx: DepthOnePerPrimary;
  other: PageId;
  direction: NeighborDirection;
}

/**
 * Emit a depth-1 neighbor edge if it survives the no-ghost / no-primary
 * / canonical-key filters. Bumps the per-target connection counter
 * either way so multi-primary connections get the documented bonus
 * even when the second edge would otherwise be skipped as a duplicate.
 */
function tryEmitDirect(input: EmitDirectInput): void {
  const { ctx, other, direction } = input;
  if (ctx.ghostIds.has(other)) return;
  if (ctx.primaryIds.has(other)) return;
  bumpConnection(ctx.connectionCount, other);
  mergeOrInsertNeighbor(ctx.emitted, {
    from: ctx.primary,
    to: other,
    direction,
    distance: 1,
    score: WEIGHT_NEIGHBOR_DIRECT,
  });
}

/** Increment the per-target connection counter (used for the multi-primary bonus). */
function bumpConnection(counter: Map<PageId, number>, target: PageId): void {
  counter.set(target, (counter.get(target) ?? 0) + 1);
}

/** Empty PageId set reused across walks to avoid allocating per call. */
const EMPTY_NEIGHBOR_SET: ReadonlySet<PageId> = new Set<PageId>();

/**
 * Walk every wikilink edge incident to `node` and invoke `onEdge` with
 * the other endpoint plus the direction relative to `node`. Centralised
 * so depth-1 and depth-2 walkers share the outgoing-then-incoming
 * iteration order without copy-pasting the boilerplate.
 */
function walkIncidentEdges(
  adjacency: Adjacency,
  node: PageId,
  onEdge: (other: PageId, direction: NeighborDirection) => void,
): void {
  const outgoing = adjacency.outgoing.get(node) ?? EMPTY_NEIGHBOR_SET;
  const incoming = adjacency.incoming.get(node) ?? EMPTY_NEIGHBOR_SET;
  for (const target of outgoing) onEdge(target, "outgoing");
  for (const source of incoming) onEdge(source, "incoming");
}

/** Candidate neighbor about to be merged into the canonical-key map. */
interface NeighborCandidate {
  from: PageId;
  to: PageId;
  direction: NeighborDirection;
  distance: number;
  score: number;
}

/**
 * Insert `candidate` into `emitted` under its canonical-pair key OR,
 * if an entry for that pair already exists, promote its direction
 * from `incoming` to `outgoing` when this edge represents the natural
 * `from -> to` link. The dedup keeps bidirectional pairs (A->B AND
 * B->A) collapsed to a single neighbor entry per the plan.
 */
function mergeOrInsertNeighbor(
  emitted: Map<string, GraphNeighbor>,
  candidate: NeighborCandidate,
): void {
  const key = canonicalPairKey(candidate.from, candidate.to);
  const existing = emitted.get(key);
  if (existing) {
    if (existing.direction === "incoming" && candidate.direction === "outgoing") {
      existing.direction = "outgoing";
    }
    return;
  }
  emitted.set(key, { ...candidate, reason: NEIGHBOR_REASON_WIKILINK });
}

/**
 * After every primary contributes, apply the per-additional-connection
 * score bonus to each neighbor entry. The first connection is the base
 * weight; only the 2nd..(MAX+1)-th add the per-hit bonus.
 */
function applyPrimaryConnectionBonus(
  emitted: Map<string, GraphNeighbor>,
  connectionCount: Map<PageId, number>,
): void {
  for (const neighbor of emitted.values()) {
    const hits = connectionCount.get(neighbor.to) ?? 0;
    const extraHits = Math.min(
      Math.max(0, hits - 1),
      MAX_PRIMARY_CONNECTION_BONUS_HITS,
    );
    neighbor.score = clampScore(
      neighbor.score + extraHits * WEIGHT_PRIMARY_CONNECTION_BONUS,
    );
  }
}

/** Inputs for depth-2 expansion. */
interface DepthTwoInput {
  primaryIds: ReadonlySet<PageId>;
  adjacency: Adjacency;
  ghostIds: ReadonlySet<PageId>;
  depthOneTargets: ReadonlySet<PageId>;
}

/**
 * Depth-2 expansion: walk from each surviving depth-1 neighbor and
 * emit edges to NEW real pages (not primary, not already at depth 1,
 * not ghosts). Bidirectional pairs at depth 2 also collapse via the
 * canonical-pair key. Back-edges to primary are dropped because that
 * relationship is already represented by the primary's depth-1 entry.
 */
function expandDepthTwo(input: DepthTwoInput): GraphNeighbor[] {
  const emitted = new Map<string, GraphNeighbor>();
  for (const bridge of input.depthOneTargets) {
    walkDepthTwoFromBridge({ ...input, bridge, emitted });
  }
  return Array.from(emitted.values());
}

/** Per-bridge depth-2 walker context; bridge is the depth-1 neighbor we expand from. */
interface DepthTwoPerBridge extends DepthTwoInput {
  bridge: PageId;
  emitted: Map<string, GraphNeighbor>;
}

/** Walk every edge incident to one depth-1 bridge node. */
function walkDepthTwoFromBridge(ctx: DepthTwoPerBridge): void {
  walkIncidentEdges(ctx.adjacency, ctx.bridge, (other, direction) => {
    tryEmitSecondHop({ ctx, other, direction });
  });
}

/** Inputs for the per-edge depth-2 emission check. */
interface EmitSecondHopInput {
  ctx: DepthTwoPerBridge;
  other: PageId;
  direction: NeighborDirection;
}

/**
 * Emit a depth-2 neighbor edge if the target is a real page that is
 * neither primary nor already in the depth-1 neighbor set. Same
 * canonical-key de-dupe rule as depth 1; direction prefers outgoing
 * on bidirectional collisions to keep the natural reading order.
 */
function tryEmitSecondHop(input: EmitSecondHopInput): void {
  const { ctx, other, direction } = input;
  if (ctx.ghostIds.has(other)) return;
  if (ctx.primaryIds.has(other)) return;
  if (ctx.depthOneTargets.has(other)) return;
  mergeOrInsertNeighbor(ctx.emitted, {
    from: ctx.bridge,
    to: other,
    direction,
    distance: 2,
    score: WEIGHT_NEIGHBOR_SECOND_HOP,
  });
}

/** Collect just the `to` ids from a depth-1 neighbor list for fast lookups. */
function collectDepthOneTargets(neighbors: GraphNeighbor[]): Set<PageId> {
  const ids = new Set<PageId>();
  for (const n of neighbors) ids.add(n.to);
  return ids;
}

/**
 * Canonical key for an unordered page pair so A->B and B->A collapse
 * to a single neighbor entry. `String.localeCompare` keeps the
 * ordering platform-stable for any unicode-bearing PageId.
 */
function canonicalPairKey(a: PageId, b: PageId): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/** Squash a score into [0, 1] without inventing precision. */
function clampScore(weight: number): number {
  if (weight <= 0) return 0;
  if (weight >= MAX_NORMALIZED_SCORE) return MAX_NORMALIZED_SCORE;
  return Math.round(weight * 100) / 100;
}

/**
 * Stable sort: descending score, then ascending `to` id. We don't have
 * neighbor titles at this layer; the namespaced PageId already sorts
 * deterministically per directory so agents see a fixed ordering.
 */
function compareNeighbors(a: GraphNeighbor, b: GraphNeighbor): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.to.localeCompare(b.to);
}

