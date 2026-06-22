/**
 * Missing-knowledge GAP emission for `llmwiki context` graph expansion.
 *
 * Split out of `src/context/graph.ts` (neighbor expansion) so each module stays
 * under the size budget and the two concerns — what a primary CAN reach
 * (neighbors) vs. what it FAILS to reach (gaps) — read independently. A gap is
 * surfaced when a primary owns a link/relation whose other endpoint has no
 * backing page (a ghost), so the missing knowledge is visible to the agent even
 * though the ghost is correctly dropped from `neighbors[]`.
 *
 * Two gap codes:
 *   - `dangling-link` — a primary page's unresolved wikilink (`danglingLinks`).
 *   - `dangling-relation` (CLP 4b) — a typed relation edge incident to a primary
 *     whose OTHER endpoint is a ghost. Names the relation type + missing
 *     endpoint. A DEFAULT (relation-less) pack never emits this code, so its
 *     serialized output is unchanged.
 *
 * Gaps are deterministic and rank-stable: link gaps follow page/`danglingLinks`
 * order; relation gaps follow the snapshot's deterministic edge order and are
 * de-duped so a symmetric relation pair yields a single gap.
 */

import type { GraphEdge, GraphNodeId, ViewerPage } from "../viewer/types.js";

/**
 * Gap entry surfaced when a primary owns a link/relation to a missing target.
 * `pageId` is keyed in the {@link GraphNodeId} space so a `dangling-relation`
 * gap can name a typed entity page (an `EntityId`); a `dangling-link` gap's
 * `pageId` is still a `PageId`.
 */
export interface GraphGap {
  code: "dangling-link" | "dangling-relation";
  message: string;
  pageId: GraphNodeId;
}

/** Inputs the gap emitters need, narrowed from the full expansion input. */
export interface GraphGapInput {
  pages: ViewerPage[];
  edges: GraphEdge[];
  primaryIds: ReadonlySet<GraphNodeId>;
  ghostIds: ReadonlySet<GraphNodeId>;
}

/** Emit every gap (wikilink dangling-links then dangling-relations) for the primaries. */
export function emitGraphGaps(input: GraphGapInput): GraphGap[] {
  return [...emitDanglingLinkGaps(input), ...emitDanglingRelationGaps(input)];
}

/** Surface dangling-link gaps for every primary page that owns one. */
function emitDanglingLinkGaps(input: GraphGapInput): GraphGap[] {
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

/**
 * Surface a `dangling-relation` gap for every typed relation edge incident to a
 * primary whose OTHER endpoint is a ghost (no backing page). Such a relation is
 * correctly dropped from `neighbors[]`, so without this the missing endpoint
 * would be invisible to the agent. Iterates the snapshot edge list in its
 * deterministic order and de-dupes so a symmetric relation pair emits one gap.
 */
function emitDanglingRelationGaps(input: GraphGapInput): GraphGap[] {
  const gaps: GraphGap[] = [];
  const seen = new Set<string>();
  for (const edge of input.edges) {
    const gap = danglingRelationGapForEdge(edge, input.primaryIds, input.ghostIds);
    if (gap === undefined) continue;
    const key = `${gap.pageId}|${edge.relationType}|${gap.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push(gap);
  }
  return gaps;
}

/**
 * Build a `dangling-relation` gap when an endpoint of a relation edge is a
 * primary and the OTHER is a ghost; otherwise return `undefined`. A wikilink
 * edge (no `relationType`) never produces a relation gap.
 */
function danglingRelationGapForEdge(
  edge: GraphEdge,
  primaryIds: ReadonlySet<GraphNodeId>,
  ghostIds: ReadonlySet<GraphNodeId>,
): GraphGap | undefined {
  if (edge.edgeKind !== "relation" || edge.relationType === undefined) return undefined;
  const primary = endpointIn(edge, primaryIds);
  if (primary === undefined) return undefined;
  const missing = primary === edge.source ? edge.target : edge.source;
  if (!ghostIds.has(missing)) return undefined;
  return {
    code: "dangling-relation",
    message: `Page has a "${edge.relationType}" relation to "${missing}", but no page exists.`,
    pageId: primary,
  };
}

/** Return whichever endpoint of `edge` is in `set`, preferring `source`; else undefined. */
function endpointIn(
  edge: GraphEdge,
  set: ReadonlySet<GraphNodeId>,
): GraphNodeId | undefined {
  if (set.has(edge.source)) return edge.source;
  if (set.has(edge.target)) return edge.target;
  return undefined;
}
