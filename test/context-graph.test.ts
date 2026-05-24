/**
 * Unit tests for the Slice 3 graph neighborhood expansion.
 *
 * Drives `expandGraphNeighborhood` against synthetic `GraphData` /
 * `ViewerPage[]` inputs so every topology rule from the plan is
 * pinned in isolation: primary exclusion, ghost-to-gap conversion,
 * canonical-pair de-dup, depth-1 incoming + outgoing edges, depth-2
 * expansion + back-edge dropping, and the depth=0 suppression knob.
 *
 * Note on the "include incoming at depth 1" rule: a primary page A
 * with edges `A→B` (outgoing) and `C→A` (incoming) yields BOTH B and
 * C as depth-1 neighbors, because the plan §Graph Expansion says
 * `include outgoing and incoming links`. The cycle test below
 * documents this — C reached via the back-edge to A is depth-1, not
 * depth-2 (and is therefore de-duped if depth-2 expansion would have
 * tried to re-emit it from B).
 */

import { describe, expect, it } from "vitest";
import { expandGraphNeighborhood } from "../src/context/graph.js";
import type {
  GraphData,
  GraphNode,
  PageId,
  ViewerPage,
} from "../src/viewer/types.js";

/** Build a real (non-dangling) GraphNode for `id`. */
function realNode(id: PageId): GraphNode {
  const slug = id.split("/")[1] ?? id;
  return {
    id,
    title: slug,
    slug,
    directory: "concepts",
    kind: "concept",
    degree: 0,
  };
}

/** Build a dangling (ghost) GraphNode for `id`. */
function ghostNode(id: PageId): GraphNode {
  const slug = id.split("/")[1] ?? id;
  return {
    id,
    title: slug,
    slug,
    directory: "concepts",
    kind: "dangling",
    degree: 0,
    isDangling: true,
  };
}

/** Build a minimal ViewerPage shell good enough for gap attribution. */
function pageShell(
  id: PageId,
  options: { danglingLinks?: { slug: string; display: string }[] } = {},
): ViewerPage {
  const slug = id.split("/")[1] ?? id;
  return {
    id,
    slug,
    pageDirectory: id.startsWith("queries/") ? "queries" : "concepts",
    title: slug,
    filePath: `/tmp/${id}.md`,
    frontmatter: {},
    body: "",
    outgoingLinks: [],
    danglingLinks: options.danglingLinks ?? [],
    citations: [],
    warnings: [],
  };
}

/** Compose a synthetic GraphData from real ids + edge pairs + optional ghosts. */
function buildSyntheticGraph(spec: {
  realIds: PageId[];
  ghostIds?: PageId[];
  edges: [PageId, PageId][];
}): GraphData {
  return {
    nodes: [
      ...spec.realIds.map(realNode),
      ...(spec.ghostIds ?? []).map(ghostNode),
    ],
    edges: spec.edges.map(([source, target]) => ({ source, target })),
  };
}

/**
 * One-stop expansion helper used by every `expandGraphNeighborhood`
 * test. Collapses the synthetic-graph + page-shells + primary-set
 * + depth boilerplate into a single call so per-test bodies focus on
 * the topology and assertions they actually care about. Pages default
 * to barebones shells for every real id; pass `pages` explicitly when
 * a test needs dangling-link attribution.
 */
function expand(spec: {
  realIds: PageId[];
  ghostIds?: PageId[];
  edges: [PageId, PageId][];
  primaryIds: PageId[];
  depth: number;
  pages?: ViewerPage[];
}) {
  return expandGraphNeighborhood({
    graph: buildSyntheticGraph({
      realIds: spec.realIds,
      ghostIds: spec.ghostIds,
      edges: spec.edges,
    }),
    pages: spec.pages ?? spec.realIds.map((id) => pageShell(id)),
    primaryIds: new Set(spec.primaryIds),
    depth: spec.depth,
  });
}

describe("expandGraphNeighborhood — depth-1 direct neighbors", () => {
  it("emits outgoing edge with direction=outgoing and distance=1", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b"],
      edges: [["concepts/a", "concepts/b"]],
      primaryIds: ["concepts/a"],
      depth: 1,
    });
    expect(out.neighbors).toHaveLength(1);
    expect(out.neighbors[0]).toMatchObject({
      from: "concepts/a",
      to: "concepts/b",
      direction: "outgoing",
      distance: 1,
      reason: "wikilink",
    });
    expect(out.gaps).toEqual([]);
  });

  it("emits incoming edge with direction=incoming when only B->A exists", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b"],
      edges: [["concepts/b", "concepts/a"]],
      primaryIds: ["concepts/a"],
      depth: 1,
    });
    expect(out.neighbors).toHaveLength(1);
    expect(out.neighbors[0]).toMatchObject({
      from: "concepts/a",
      to: "concepts/b",
      direction: "incoming",
      distance: 1,
    });
  });
});

describe("expandGraphNeighborhood — primary exclusion", () => {
  it("never emits a neighbor entry whose target is itself a primary page", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b"],
      edges: [["concepts/a", "concepts/b"]],
      primaryIds: ["concepts/a", "concepts/b"],
      depth: 1,
    });
    expect(out.neighbors).toEqual([]);
  });
});

describe("expandGraphNeighborhood — dangling-to-gap conversion", () => {
  it("converts ghost link targets into gaps tied to the source page", async () => {
    const out = expand({
      realIds: ["concepts/a"],
      ghostIds: ["concepts/missing"],
      edges: [["concepts/a", "concepts/missing"]],
      pages: [
        pageShell("concepts/a", {
          danglingLinks: [{ slug: "missing", display: "Missing Topic" }],
        }),
      ],
      primaryIds: ["concepts/a"],
      depth: 1,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.gaps).toEqual([
      {
        code: "dangling-link",
        message: "Page links to [[Missing Topic]], but no page exists.",
        pageId: "concepts/a",
      },
    ]);
  });

  it("emits one gap per (source-page, dangling-target) pair", async () => {
    const out = expand({
      realIds: ["concepts/a"],
      ghostIds: ["concepts/x", "concepts/y"],
      edges: [
        ["concepts/a", "concepts/x"],
        ["concepts/a", "concepts/y"],
      ],
      pages: [
        pageShell("concepts/a", {
          danglingLinks: [
            { slug: "x", display: "X" },
            { slug: "y", display: "Y" },
          ],
        }),
      ],
      primaryIds: ["concepts/a"],
      depth: 1,
    });
    expect(out.gaps).toHaveLength(2);
    for (const gap of out.gaps) expect(gap.pageId).toBe("concepts/a");
  });
});

describe("expandGraphNeighborhood — canonical-pair de-dup", () => {
  it("collapses bidirectional A<->B into one neighbor entry, preferring outgoing direction", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/a"],
      ],
      primaryIds: ["concepts/a"],
      depth: 1,
    });
    expect(out.neighbors).toHaveLength(1);
    expect(out.neighbors[0]).toMatchObject({
      from: "concepts/a",
      to: "concepts/b",
      direction: "outgoing",
    });
  });
});

describe("expandGraphNeighborhood — depth-2 expansion", () => {
  it("on a linear A->B->C chain with primary={A}, emits C at distance 2", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b", "concepts/c"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/c"],
      ],
      primaryIds: ["concepts/a"],
      depth: 2,
    });
    const distances = new Map(out.neighbors.map((n) => [n.to, n.distance]));
    expect(distances.get("concepts/b")).toBe(1);
    expect(distances.get("concepts/c")).toBe(2);
    // Depth-2 entry's `from` is the bridge node, not the primary.
    const second = out.neighbors.find((n) => n.to === "concepts/c");
    expect(second?.from).toBe("concepts/b");
  });

  it("on a 3-cycle A->B->C->A with primary={A}, emits C once and never re-emits A or B", async () => {
    // Depth-1 sees C via the C->A back-edge (incoming), so C is at
    // distance 1 — NOT distance 2. The cycle still must not produce
    // duplicates, infinite loops, or any entry whose `to` is the
    // primary page A.
    const out = expand({
      realIds: ["concepts/a", "concepts/b", "concepts/c"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/c"],
        ["concepts/c", "concepts/a"],
      ],
      primaryIds: ["concepts/a"],
      depth: 2,
    });
    const toIds = out.neighbors.map((n) => n.to);
    expect(toIds.filter((id) => id === "concepts/c")).toHaveLength(1);
    expect(toIds).not.toContain("concepts/a");
  });

  it("drops depth-2 back-edges to primary so A is never a target", async () => {
    // A->B, B->A would emit B as primary's depth-1 neighbor (bidirectional
    // collapse). depth-2 from B sees A as incoming/outgoing; A is primary,
    // so it must be dropped — not re-emitted at distance 2.
    const out = expand({
      realIds: ["concepts/a", "concepts/b", "concepts/c"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/c"],
        ["concepts/b", "concepts/a"],
      ],
      primaryIds: ["concepts/a"],
      depth: 2,
    });
    expect(out.neighbors.find((n) => n.to === "concepts/a")).toBeUndefined();
  });

  it("does not re-emit depth-1 neighbors at depth 2 (existing-set exclusion)", async () => {
    // A->B->A (mutual), B->C. Depth-1 from A: {B}. Depth-2 from B:
    // C is new (good), but A is primary (drop) and the canonical
    // pair (A,B) already exists at depth 1 so no second emission.
    const out = expand({
      realIds: ["concepts/a", "concepts/b", "concepts/c"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/a"],
        ["concepts/b", "concepts/c"],
      ],
      primaryIds: ["concepts/a"],
      depth: 2,
    });
    const bEntries = out.neighbors.filter((n) => n.to === "concepts/b");
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].distance).toBe(1);
  });
});

describe("expandGraphNeighborhood — depth 0 + empty inputs", () => {
  it("depth 0 suppresses both neighbors and gaps even when dangling links exist", async () => {
    const out = expand({
      realIds: ["concepts/a"],
      ghostIds: ["concepts/missing"],
      edges: [["concepts/a", "concepts/missing"]],
      pages: [
        pageShell("concepts/a", {
          danglingLinks: [{ slug: "missing", display: "Missing" }],
        }),
      ],
      primaryIds: ["concepts/a"],
      depth: 0,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.gaps).toEqual([]);
  });

  it("empty primaryIds produces empty neighbors AND empty gaps", async () => {
    const out = expand({
      realIds: ["concepts/a"],
      edges: [],
      primaryIds: [],
      depth: 2,
    });
    expect(out.neighbors).toEqual([]);
    expect(out.gaps).toEqual([]);
  });
});

describe("expandGraphNeighborhood — scoring + ordering", () => {
  it("ranks direct (distance 1) neighbors ahead of second-hop (distance 2)", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/b", "concepts/c"],
      edges: [
        ["concepts/a", "concepts/b"],
        ["concepts/b", "concepts/c"],
      ],
      primaryIds: ["concepts/a"],
      depth: 2,
    });
    expect(out.neighbors[0].distance).toBe(1);
    expect(out.neighbors[1].distance).toBe(2);
    expect(out.neighbors[0].score).toBeGreaterThan(out.neighbors[1].score);
  });

  it("multi-primary connections to the same neighbor bump its score over a single-primary connection", async () => {
    const out = expand({
      realIds: ["concepts/a", "concepts/c", "concepts/shared", "concepts/lonely"],
      edges: [
        ["concepts/a", "concepts/shared"],
        ["concepts/c", "concepts/shared"],
        ["concepts/a", "concepts/lonely"],
      ],
      primaryIds: ["concepts/a", "concepts/c"],
      depth: 1,
    });
    const shared = out.neighbors.find((n) => n.to === "concepts/shared");
    const lonely = out.neighbors.find((n) => n.to === "concepts/lonely");
    expect(shared).toBeDefined();
    expect(lonely).toBeDefined();
    expect(shared!.score).toBeGreaterThan(lonely!.score);
  });
});
