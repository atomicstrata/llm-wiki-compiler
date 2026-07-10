/**
 * @file test/relation-lifecycle-seam-integration.test.ts
 * @description REAL-SURFACE integration coverage for the relation/lifecycle
 * executor kinds (Phase 4, Task 6). Drives the PUBLIC SDK surface
 * (`createWiki(...).createRelation` / `.transitionLifecycle`, the staging
 * facade) against a temp project with a NON-DEFAULT profile (an entity type
 * carrying a lifecycle FSM + a declared relation type + a couple of entity
 * pages), and asserts end-to-end:
 *  - a relation create returns a `rel_…` ref AND the record lands in
 *    `wiki/graph/relations.jsonl` (the store is read back);
 *  - a legal lifecycle transition flips the page's lifecycle frontmatter on
 *    disk AND emits a `lifecycle-transition` event carrying a TOP-LEVEL
 *    `decision: "allow"` in the event store;
 *  - a denied relation (undeclared type) and an illegal lifecycle transition
 *    each fail closed with nothing written;
 *  - the public surfaces are single-mutation per call, so a mixed/multi
 *    cross-store batch is not constructible from them — the executor's
 *    {@link CrossStoreBatchUnsupportedError} guard is asserted directly for a
 *    hand-built mixed batch (proving the guard exists even though no public
 *    surface can reach it).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { readRelations } from "../src/relations/store-read.js";
import { applyApprovedMutations } from "../src/trust/executor.js";
import { CrossStoreBatchUnsupportedError } from "../src/trust/apply-result.js";
import type {
  PlannedMutation,
  RelationPlannedMutation,
  LifecycleTransitionPlannedMutation,
} from "../src/trust/planner.js";
import { buildSeamProject, pageLifecycle, expectLifecycleEventDecision } from "./fixtures/seam-fixtures.js";

const PAPER_A = "papers/a" as EntityId;
const PAPER_B = "papers/b" as EntityId;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-lc-seam-int-"));
  await buildSeamProject(root);
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("createWiki() relation kind — real-surface end-to-end", () => {
  it("createRelation returns a rel_ ref AND the record lands in relations.jsonl", async () => {
    const wiki = createWiki({ root });
    const ref = await wiki.createRelation({ type: "cites", from: PAPER_A, to: PAPER_B, attributes: {} });
    expect(ref.id).toMatch(/^rel_/);
    const { relations } = await readRelations(root);
    expect(relations).toMatchObject([{ id: ref.id, type: "cites", from: PAPER_A, to: PAPER_B }]);
  });

  it("a denied relation (undeclared type) fails closed — nothing appended", async () => {
    const wiki = createWiki({ root });
    await expect(
      wiki.createRelation({ type: "undeclared", from: PAPER_A, to: PAPER_B, attributes: {} }),
    ).rejects.toBeTruthy();
    expect((await readRelations(root)).relations).toHaveLength(0);
  });
});

describe("createWiki() lifecycle kind — real-surface end-to-end", () => {
  it("a legal transition flips the on-disk field AND emits a top-level decision:allow event", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "papers", slug: "a", toState: "review" });
    expect(await pageLifecycle(root, "a")).toBe("review");
    await expectLifecycleEventDecision(root, "allow"); // TOP-LEVEL, mirroring relation events
  });

  it("an illegal transition fails closed — page lifecycle field unchanged", async () => {
    const wiki = createWiki({ root });
    await expect(
      wiki.transitionLifecycle({ entityType: "papers", slug: "a", toState: "published" }),
    ).rejects.toBeTruthy();
    expect(await pageLifecycle(root, "a")).toBe("draft");
  });
});

describe("cross-store batch is unreachable from the public surfaces but guarded", () => {
  /** An intent-only relation mutation (the dispatcher rejects before its handler). */
  function relationMutation(from: string): RelationPlannedMutation {
    return {
      kind: "relation",
      operation: "create",
      input: { type: "cites", from, to: "papers/b", attributes: {} } as never,
    };
  }
  /** An intent-only lifecycle mutation (the dispatcher rejects before its handler). */
  function lifecycleMutation(): LifecycleTransitionPlannedMutation {
    return { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "review" };
  }

  it("a hand-built mixed relation+lifecycle batch throws CrossStoreBatchUnsupportedError", async () => {
    const batch: PlannedMutation[] = [relationMutation("papers/a"), lifecycleMutation()];
    await expect(applyApprovedMutations(root, batch)).rejects.toBeInstanceOf(CrossStoreBatchUnsupportedError);
  });

  it("a hand-built multi-relation batch is also rejected as cross-store-batch-unsupported", async () => {
    const batch: PlannedMutation[] = [relationMutation("papers/a"), relationMutation("papers/c")];
    await expect(applyApprovedMutations(root, batch)).rejects.toThrow(/^cross-store-batch-unsupported:/);
  });
});
