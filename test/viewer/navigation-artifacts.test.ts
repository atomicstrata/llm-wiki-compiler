/**
 * @file test/viewer/navigation-artifacts.test.ts
 * @description The derived navigation artifacts of AS-1 §4.9 `visualize`:
 * per-entity-type colour groups, labelled typed Canvas edges, focused
 * subgraphs, and the create-only write that preserves user customizations.
 *
 * THE COLOUR GROUPS COME FROM THE PROFILE'S DECLARED TYPES, not from the types
 * the graph happens to contain — otherwise adding the first page of a new kind
 * would silently re-colour every existing group, and a kind with no pages yet
 * would have no colour at all.
 *
 * THE FOCUS VIEW TRAVERSES BOTH DIRECTIONS. An operator asking what surrounds a
 * paper wants what it cites AND what cites it; following only the declared
 * direction would silently halve the neighbourhood while looking correct.
 */

import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canvasDocument, focusSubgraph, obsidianGraphConfig,
} from "../../src/viewer/navigation-artifacts.js";
import { writeDerivedArtifact } from "../../src/viewer/navigation-write.js";
import type { GraphData } from "../../src/viewer/types.js";

/** A three-node chain: alpha -cites-> beta, and gamma -cites-> alpha. */
function chainGraph(): GraphData {
  return {
    nodes: ["alpha", "beta", "gamma"].map((slug) => ({
      id: `papers/${slug}`, title: slug, slug, directory: "papers", kind: "papers", degree: 1,
    })),
    edges: [
      { source: "papers/alpha", target: "papers/beta", edgeKind: "relation", relationType: "cites" },
      { source: "papers/gamma", target: "papers/alpha", edgeKind: "relation", relationType: "cites" },
    ],
  } as unknown as GraphData;
}

describe("obsidian graph configuration", () => {
  it("emits one colour group per declared entity type, in declaration order", () => {
    const config = obsidianGraphConfig(["papers", "concepts", "people"]);
    expect(config.colorGroups.map((group) => group.query))
      .toEqual(["path:wiki/papers", "path:wiki/concepts", "path:wiki/people"]);
  });

  it("gives a declared type with no pages its own colour", () => {
    // Derived from the profile, not the data: a kind nobody has written yet
    // still gets a stable group rather than appearing only once populated.
    expect(obsidianGraphConfig(["foundations"]).colorGroups).toHaveLength(1);
  });

  it("gives distinct types distinct colours", () => {
    const colors = obsidianGraphConfig(["a", "b", "c"]).colorGroups.map((group) => group.color.rgb);
    expect(new Set(colors).size).toBe(3);
  });
});

describe("canvas document", () => {
  it("labels each typed edge with its relation type", () => {
    expect(canvasDocument(chainGraph()).edges.map((edge) => edge.label)).toEqual(["cites", "cites"]);
  });

  it("carries one node per graph node", () => {
    expect(canvasDocument(chainGraph()).nodes.map((node) => node.id))
      .toEqual(["papers/alpha", "papers/beta", "papers/gamma"]);
  });

  it("drops an edge whose endpoint is not in the document, keeping the rest", () => {
    const graph = chainGraph();
    (graph.edges as unknown[]).push({ source: "papers/alpha", target: "papers/ghost" });
    expect(canvasDocument(graph).edges).toHaveLength(2);
  });
});

describe("focused subgraph", () => {
  it("returns the focus alone at depth 0", () => {
    expect(focusSubgraph(chainGraph(), "papers/alpha", 0).nodes.map((node) => node.id))
      .toEqual(["papers/alpha"]);
  });

  it("reaches BOTH the cited and the citing neighbour at depth 1", () => {
    // beta is downstream of alpha; gamma is upstream. A directed-only walk
    // would return beta and silently omit gamma.
    const ids = focusSubgraph(chainGraph(), "papers/alpha", 1).nodes.map((node) => node.id).sort();
    expect(ids).toEqual(["papers/alpha", "papers/beta", "papers/gamma"]);
  });

  it("returns an empty graph for a node that is not present", () => {
    expect(focusSubgraph(chainGraph(), "papers/nope", 2)).toEqual({ nodes: [], edges: [] });
  });
});

describe("writing derived artifacts", () => {
  it("creates the artifact when none exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nav-"));
    const result = await writeDerivedArtifact(root, "wiki/.obsidian/graph.json", "{}");
    expect(result.outcome).toBe("created");
    expect(await readFile(path.join(root, "wiki/.obsidian/graph.json"), "utf8")).toBe("{}");
  });

  it("NEVER overwrites a customization the user already made", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nav-"));
    await mkdir(path.join(root, "wiki/.obsidian"), { recursive: true });
    await writeFile(path.join(root, "wiki/.obsidian/graph.json"), "MINE", "utf8");
    const result = await writeDerivedArtifact(root, "wiki/.obsidian/graph.json", "{}");
    expect(result.outcome).toBe("skipped-existing");
    // The bytes, not just the outcome: a report of "skipped" beside a rewritten
    // file would be the worst of both.
    expect(await readFile(path.join(root, "wiki/.obsidian/graph.json"), "utf8")).toBe("MINE");
  });
});
