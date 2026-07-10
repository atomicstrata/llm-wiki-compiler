/**
 * @file test/viewer-graph-profile-filter.test.ts
 * @description Audit FIX F4: the viewer-snapshot graph must PROFILE-FILTER typed
 * relations, matching status/export/lint. A relation whose type the profile has
 * since removed is no longer profile-valid, so its edge must NOT be reanimated in
 * the graph (status already reports it invalid + not-counted). A still-valid
 * relation still appears.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
  RESEARCH_LITE_PROFILE,
} from "./fixtures/profile-fixtures.js";
import { expectTestsRelationEdge } from "./fixtures/graph-store-confine.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "viewer-graph-filter-"));
  await buildResearchLiteRelationsProject(root);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Overwrite the on-disk profile so the `tests` relation type is no longer declared. */
async function removeRelationType(): Promise<void> {
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(RESEARCH_LITE_PROFILE, null, 2)}\n`, "utf8");
}

const relationEdges = (edges: { edgeKind?: string }[]) => edges.filter((e) => e.edgeKind === "relation");

describe("FIX F4 — graph excludes profile-invalid relations", () => {
  it("does NOT emit an edge for a relation whose type the profile removed", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await removeRelationType(); // profile no longer declares `tests` → the stored relation is now invalid
    const { graph } = await buildViewerSnapshot(root);
    expect(relationEdges(graph.edges)).toEqual([]);
  });

  it("still emits the edge for a relation that remains profile-valid", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const { graph } = await buildViewerSnapshot(root);
    expectTestsRelationEdge(graph.edges);
  });
});
