/**
 * @file test/viewer-graph-invalid-page.test.ts
 * @description Holistic review FIX 3: a profile-INVALID typed page (missing a
 * required field) is EXCLUDED from the snapshot GRAPH node builder
 * (`collectTypedGraphInputs`), mirroring T5a's context-pool exclusion via the
 * SHARED `invalidEntityPagePaths`. An invalid page that is a relation endpoint is
 * therefore NOT a real `nodeKind:"entity"` node — it becomes a relation-ghost
 * (`isDangling:true`) so the dangling edge surfaces consistently with the context
 * pool, while a VALID typed page IS a real entity node. DEFAULT parity is
 * unaffected (no typed inputs at all).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { appendRelation } from "../src/relations/store.js";
import { writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";

const VALID = "papers/valid-paper" as EntityId;
const INVALID = "papers/broken-paper" as EntityId;

/** A `papers` profile (title required) with a symmetric `cites` relation type. */
function profile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "lib",
    entities: {
      papers: { directory: "wiki/papers", requiredFields: ["title"], fields: { title: { type: "string" } } },
    },
    relations: { cites: { from: ["papers"], to: ["papers"], direction: "symmetric" } },
  };
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "viewer-graph-invalid-"));
  await writeProfileFile(root, profile());
  await writeMarkdownPage(root, "wiki/papers", "valid-paper", "---\ntitle: Valid\n---\nbody");
  await writeMarkdownPage(root, "wiki/papers", "broken-paper", "---\nvenue: NeurIPS\n---\nbody"); // no title → field-violation
  await appendRelation(root, profile(), { type: "cites", from: VALID, to: INVALID });
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("FIX 3 — invalid typed page excluded from the graph node builder", () => {
  it("the VALID page is a real entity node; the INVALID endpoint is a dangling ghost", async () => {
    const { graph } = await buildViewerSnapshot(root);
    const valid = graph.nodes.find((n) => n.id === VALID);
    const invalid = graph.nodes.find((n) => n.id === INVALID);
    expect(valid?.nodeKind).toBe("entity");
    expect(invalid?.nodeKind).toBeUndefined();
    expect(invalid?.isDangling).toBe(true);
  });

  it("the relation incident to the invalid page is still a graph edge (now to a ghost)", async () => {
    const { graph } = await buildViewerSnapshot(root);
    // The `cites` type is symmetric, so the stored endpoints canonicalize by sort
    // order — assert on the incident pair without assuming a direction.
    const endpoints = new Set<string>([VALID, INVALID]);
    const edge = graph.edges.find(
      (e) => e.edgeKind === "relation" && endpoints.has(e.source) && endpoints.has(e.target),
    );
    expect(edge).toMatchObject({ edgeKind: "relation", relationType: "cites" });
  });
});
