/**
 * Tests for the graph data builder (`src/viewer/graph.ts`).
 *
 * Covers adjacency construction, degree calculation, dangling-link
 * exclusion, and frontmatter.kind defaulting. All tests use minimal
 * in-memory `ViewerPage` fixtures — no filesystem access required.
 */

import { describe, it, expect } from "vitest";
import { buildGraphData } from "../src/viewer/graph.js";
import type { EntityPageNode, RelationEdge } from "../src/viewer/graph.js";
import type { PageId, ViewerPage } from "../src/viewer/types.js";
import type { EntityId } from "../src/profile/types.js";

/** Build a typed entity-page node input keyed by its `<type>/<slug>` EntityId. */
function entityNode(entityType: string, slug: string): EntityPageNode {
  return { id: `${entityType}/${slug}` as EntityId, entityType, slug, directory: entityType };
}

/** Build a typed relation edge input between two entity ids with optional direction. */
function relation(type: string, from: string, to: string, direction?: "directed" | "symmetric"): RelationEdge {
  return { type, from: from as EntityId, to: to as EntityId, ...(direction ? { direction } : {}) };
}

/** Build a minimal ViewerPage fixture for graph tests. */
function makePage(
  id: PageId,
  outgoingLinks: PageId[] = [],
  frontmatter: Record<string, unknown> = {},
  danglingLinks: { slug: string; display: string }[] = [],
): ViewerPage {
  const parts = id.split("/");
  const pageDirectory = parts[0] as "concepts" | "queries";
  const slug = parts.slice(1).join("/");
  if (pageDirectory !== "concepts" && pageDirectory !== "queries") {
    throw new Error(`Invalid test fixture pageDirectory: ${pageDirectory}`);
  }
  return {
    id,
    slug,
    pageDirectory,
    title: slug,
    filePath: `/tmp/${slug}.md`,
    frontmatter,
    body: "",
    outgoingLinks,
    danglingLinks,
    citations: [],
    warnings: [],
  };
}

describe("buildGraphData — empty and trivial inputs", () => {
  it("returns empty nodes and edges for an empty page list", () => {
    expect(buildGraphData([])).toEqual({ nodes: [], edges: [] });
  });

  it("returns a single node with degree 0 for a page with no outgoing links", () => {
    const pages = [makePage("concepts/a" as PageId)];
    const { nodes, edges } = buildGraphData(pages);
    expect(edges).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("concepts/a");
    expect(nodes[0].degree).toBe(0);
  });
});

describe("buildGraphData — edge construction and degree", () => {
  it("emits one edge when A links to B; A has outDegree 1, B has inDegree 1", () => {
    const pages = [
      makePage("concepts/a" as PageId, ["concepts/b" as PageId]),
      makePage("concepts/b" as PageId),
    ];
    const { nodes, edges } = buildGraphData(pages);
    expect(edges).toEqual([{ source: "concepts/a", target: "concepts/b" }]);
    const nodeA = nodes.find((n) => n.id === "concepts/a");
    const nodeB = nodes.find((n) => n.id === "concepts/b");
    expect(nodeA?.degree).toBe(1);
    expect(nodeB?.degree).toBe(1);
  });

  it("emits two edges and degree 2 for each when A and B link to each other", () => {
    const pages = [
      makePage("concepts/a" as PageId, ["concepts/b" as PageId]),
      makePage("concepts/b" as PageId, ["concepts/a" as PageId]),
    ];
    const { nodes, edges } = buildGraphData(pages);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ source: "concepts/a", target: "concepts/b" });
    expect(edges).toContainEqual({ source: "concepts/b", target: "concepts/a" });
    for (const node of nodes) {
      expect(node.degree).toBe(2);
    }
  });

  it("includes dangling edges and creates a ghost node; real node out-degree is not inflated", () => {
    const pages = [makePage("concepts/a" as PageId, [], {}, [{ slug: "ghost", display: "Ghost Page" }])];
    const { nodes, edges } = buildGraphData(pages);
    expect(edges).toEqual([{ source: "concepts/a", target: "concepts/ghost" }]);
    const realNode = nodes.find((n) => n.id === "concepts/a");
    const ghostNode = nodes.find((n) => n.id === "concepts/ghost");
    expect(realNode?.degree).toBe(0);
    expect(ghostNode).toBeDefined();
    expect(ghostNode?.isDangling).toBe(true);
    expect(ghostNode?.kind).toBe("dangling");
    expect(ghostNode?.degree).toBe(1);
    expect(ghostNode?.title).toBe("Ghost Page");
  });
});

describe("buildGraphData — frontmatter.kind defaulting", () => {
  it("defaults kind to 'concept' when frontmatter.kind is missing", () => {
    const pages = [makePage("concepts/a" as PageId)];
    const { nodes } = buildGraphData(pages);
    expect(nodes[0].kind).toBe("concept");
  });

  it("uses frontmatter.kind when present", () => {
    const pages = [makePage("concepts/a" as PageId, [], { kind: "entity" })];
    const { nodes } = buildGraphData(pages);
    expect(nodes[0].kind).toBe("entity");
  });
});

describe("buildGraphData — typed entity pages + relations (CLP 4b)", () => {
  it("is byte-identical to the no-opts call when opts is empty", () => {
    const pages = [makePage("concepts/a" as PageId, ["concepts/b" as PageId]), makePage("concepts/b" as PageId)];
    expect(buildGraphData(pages, {})).toEqual(buildGraphData(pages));
    expect(buildGraphData(pages, { entityPages: [], relations: [] })).toEqual(buildGraphData(pages));
  });

  it("appends typed nodes (keyed by EntityId, tagged by entityType) sorted by id", () => {
    const opts = { entityPages: [entityNode("person", "bob"), entityNode("person", "amy")] };
    const { nodes } = buildGraphData([], opts);
    expect(nodes.map((n) => n.id)).toEqual(["person/amy", "person/bob"]);
    expect(nodes[0]).toMatchObject({ id: "person/amy", kind: "person", nodeKind: "entity", entityType: "person" });
  });

  it("appends a relation edge tagged by relationType and counts endpoint degree", () => {
    const opts = { entityPages: [entityNode("person", "amy"), entityNode("person", "bob")], relations: [relation("knows", "person/amy", "person/bob")] };
    const { nodes, edges } = buildGraphData([], opts);
    expect(edges).toEqual([{ source: "person/amy", target: "person/bob", edgeKind: "relation", relationType: "knows" }]);
    expect(nodes.find((n) => n.id === "person/amy")?.degree).toBe(1);
  });

  it("makes a missing relation endpoint a ghost node without crashing", () => {
    const opts = { entityPages: [entityNode("person", "amy")], relations: [relation("knows", "person/amy", "person/ghost")] };
    const { nodes } = buildGraphData([], opts);
    const ghost = nodes.find((n) => n.id === "person/ghost");
    expect(ghost).toMatchObject({ isDangling: true, kind: "dangling", directory: "person", slug: "ghost" });
    expect(nodes.find((n) => n.id === "person/amy")?.nodeKind).toBe("entity");
  });

  it("carries direction:symmetric on a symmetric relation edge", () => {
    const opts = { entityPages: [entityNode("person", "amy"), entityNode("person", "bob")], relations: [relation("knows", "person/amy", "person/bob", "symmetric")] };
    const { edges } = buildGraphData([], opts);
    expect(edges[0]).toMatchObject({ edgeKind: "relation", relationType: "knows", direction: "symmetric" });
  });

  it("carries direction:directed on a directed relation edge", () => {
    const opts = { entityPages: [entityNode("person", "amy"), entityNode("person", "bob")], relations: [relation("tests", "person/amy", "person/bob", "directed")] };
    const { edges } = buildGraphData([], opts);
    expect(edges[0]).toMatchObject({ edgeKind: "relation", relationType: "tests", direction: "directed" });
  });

  it("omits direction on a relation edge when none is supplied (additive)", () => {
    const opts = { entityPages: [entityNode("person", "amy"), entityNode("person", "bob")], relations: [relation("knows", "person/amy", "person/bob")] };
    const { edges } = buildGraphData([], opts);
    expect(edges[0]).not.toHaveProperty("direction");
  });
});
