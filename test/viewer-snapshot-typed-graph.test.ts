/**
 * Integration tests: the viewer snapshot graph surfaces typed entity pages +
 * relations for a NON-DEFAULT profile (CLP 4b). This is the call-site wiring
 * proof — `buildViewerSnapshot` reads the profile's entity pages + relation
 * store and passes them to `buildGraphData`, so typed nodes/edges appear in the
 * frozen `graph` (which also feeds agent context expansion). A relation to a
 * missing endpoint becomes a ghost node without crashing.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
} from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "viewer-typed-graph-"));
  await buildResearchLiteRelationsProject(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("buildViewerSnapshot — typed entity pages + relations in the graph", () => {
  it("includes typed entity nodes keyed by EntityId and tagged by entityType", async () => {
    const { graph } = await buildViewerSnapshot(root);
    const paper = graph.nodes.find((n) => n.id === "papers/scaling-laws");
    expect(paper).toMatchObject({ nodeKind: "entity", entityType: "papers", kind: "papers" });
  });

  it("includes the relation edge tagged by relationType between its endpoints", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const { graph } = await buildViewerSnapshot(root);
    expect(graph.edges).toContainEqual({
      source: "experiments/ablation-batch-size",
      target: "ideas/sparse-routing",
      edgeKind: "relation",
      relationType: "tests",
    });
  });

  it("makes a relation to a missing endpoint a ghost node without crashing", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "does-not-exist");
    const { graph } = await buildViewerSnapshot(root);
    const ghost = graph.nodes.find((n) => n.id === "ideas/does-not-exist");
    expect(ghost).toMatchObject({ isDangling: true, kind: "dangling" });
  });
});
