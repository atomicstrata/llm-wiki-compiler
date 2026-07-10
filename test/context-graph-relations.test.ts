/**
 * Tests for context graph expansion across TYPED RELATION edges (CLP 4b).
 *
 * `buildGraphData(pages, { entityPages, relations })` surfaces typed entity
 * nodes and relation edges in ONE graph that feeds BOTH the viewer snapshot and
 * `expandGraphNeighborhood`. These tests drive the expander over that augmented
 * graph to pin: relation edges are traversed as neighbors, the depth cap holds,
 * a cyclic/symmetric relation does not loop, and a dangling relation endpoint
 * (a ghost) is dropped rather than crashing.
 */

import { describe, expect, it } from "vitest";
import { buildGraphData } from "../src/viewer/graph.js";
import type { EntityPageNode, RelationEdge } from "../src/viewer/graph.js";
import { expandGraphNeighborhood } from "../src/context/graph.js";
import type { GraphNodeId } from "../src/viewer/types.js";
import type { EntityId } from "../src/profile/types.js";

/** A typed entity-page node keyed by its `<type>/<slug>` EntityId. */
function entity(slug: string): EntityPageNode {
  return { id: `person/${slug}` as EntityId, entityType: "person", slug, directory: "person" };
}

/** A typed relation edge between two `person/*` entity ids. */
function rel(from: string, to: string): RelationEdge {
  return { type: "knows", from: from as EntityId, to: to as EntityId };
}

/** Expand from `primary` over a graph built from the given entity pages + relations. */
function expandRelations(spec: {
  entityPages: EntityPageNode[];
  relations: RelationEdge[];
  primary: string;
  depth: number;
}) {
  const graph = buildGraphData([], { entityPages: spec.entityPages, relations: spec.relations });
  return expandGraphNeighborhood({
    graph,
    pages: [],
    primaryIds: new Set<GraphNodeId>([spec.primary as EntityId]),
    depth: spec.depth,
  });
}

/** Expand the single `amy --knows--> bob` relation at depth 1 (both pages real). */
function expandAmyKnowsBob() {
  return expandRelations({
    entityPages: [entity("amy"), entity("bob")],
    relations: [rel("person/amy", "person/bob")],
    primary: "person/amy",
    depth: 1,
  });
}

/** Expand `amy --knows--> ghost` where the endpoint has no backing page. */
function expandAmyKnowsGhost() {
  return expandRelations({
    entityPages: [entity("amy")],
    relations: [rel("person/amy", "person/ghost")],
    primary: "person/amy",
    depth: 2,
  });
}

describe("expandGraphNeighborhood — typed relation edges (CLP 4b)", () => {
  it("expands from a typed page along a relation edge to its depth-1 neighbor", () => {
    const out = expandAmyKnowsBob();
    expect(out.neighbors).toHaveLength(1);
    expect(out.neighbors[0]).toMatchObject({ from: "person/amy", to: "person/bob", distance: 1 });
  });

  it("respects the depth cap: depth 1 does not reach the second-hop neighbor", () => {
    const out = expandRelations({
      entityPages: [entity("amy"), entity("bob"), entity("cara")],
      relations: [rel("person/amy", "person/bob"), rel("person/bob", "person/cara")],
      primary: "person/amy",
      depth: 1,
    });
    expect(out.neighbors.map((n) => n.to)).toEqual(["person/bob"]);
  });

  it("is cycle-safe: a symmetric/cyclic relation does not loop or re-emit the primary", () => {
    const out = expandRelations({
      entityPages: [entity("amy"), entity("bob")],
      relations: [rel("person/amy", "person/bob"), rel("person/bob", "person/amy")],
      primary: "person/amy",
      depth: 2,
    });
    expect(out.neighbors.map((n) => n.to)).toEqual(["person/bob"]);
  });

  it("is dangling-safe: a relation to a missing endpoint (ghost) is dropped from neighbors", () => {
    expect(expandAmyKnowsGhost().neighbors).toEqual([]);
  });

  it("emits a dangling-relation gap naming the relation type + missing endpoint", () => {
    const out = expandAmyKnowsGhost();
    expect(out.neighbors).toEqual([]);
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]).toMatchObject({ code: "dangling-relation", pageId: "person/amy" });
    expect(out.gaps[0].message).toContain("knows");
    expect(out.gaps[0].message).toContain("person/ghost");
  });

  it("labels a relation-derived neighbor with reason 'relation' + relationType, not 'wikilink'", () => {
    const out = expandAmyKnowsBob();
    expect(out.neighbors).toHaveLength(1);
    expect(out.neighbors[0]).toMatchObject({ reason: "relation", relationType: "knows" });
  });
});
