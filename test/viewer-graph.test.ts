/**
 * Tests for the graph data builder (`src/viewer/graph.ts`).
 *
 * Covers adjacency construction, degree calculation, dangling-link
 * exclusion, and frontmatter.kind defaulting. All tests use minimal
 * in-memory `ViewerPage` fixtures — no filesystem access required.
 */

import { describe, it, expect } from "vitest";
import { buildGraphData } from "../src/viewer/graph.js";
import type { PageId, ViewerPage } from "../src/viewer/types.js";

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
