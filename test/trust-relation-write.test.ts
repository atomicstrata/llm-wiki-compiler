/**
 * @file test/trust-relation-write.test.ts
 * @description Tests for the trust-gated relation-write + lifecycle-transition
 * APIs (Phase 4 PR5) at the trust layer (no SDK facade).
 *
 * Relation writes route through the planner ({@link planRelationMutation}) and,
 * only when allowed, append to the PR4 store under one lock; lifecycle
 * transitions are a validated read-modify-write through the existing typed page
 * path, which re-runs the PR2 lifecycle gate. The fixture profile carries a
 * `tests` relation (experiments→ideas) and the research-lite `ideas` lifecycle.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { createRelation, RelationWriteDeniedError } from "../src/trust/relation-write.js";
import { transitionLifecycle, LifecycleTransitionUnavailableError } from "../src/trust/lifecycle-transition.js";
import { LifecycleTransitionError } from "../src/profile/lifecycle.js";
import { readRelations } from "../src/relations/store-read.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

const EXP = "experiments/ablation-batch-size" as EntityId;
const IDEA = "ideas/sparse-routing" as EntityId;

/** A research-lite profile carrying a `tests` relation experiments→ideas. */
function relationProfile(): ProfilePack {
  return {
    ...RESEARCH_LITE_PROFILE,
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  } as ProfilePack;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "trust-relation-"));
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(relationProfile()), "utf8");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("createRelation (planner-gated)", () => {
  it("appends a valid relation and returns a readable RelationRef", async () => {
    const ref = await createRelation(root, relationProfile(), { type: "tests", from: EXP, to: IDEA });
    expect(ref.id).toMatch(/^rel_/);
    const store = await readRelations(root);
    expect(store.problems).toEqual([]);
    expect(store.relations).toMatchObject([{ id: ref.id, type: "tests", from: EXP, to: IDEA }]);
  });

  it("denies an undeclared relation type, writing nothing", async () => {
    const bad = createRelation(root, relationProfile(), { type: "nope", from: EXP, to: IDEA });
    await expect(bad).rejects.toBeInstanceOf(RelationWriteDeniedError);
    await expect(readRelations(root)).resolves.toMatchObject({ relations: [] });
  });

  it("denies a wrong endpoint entity type, writing nothing", async () => {
    const bad = createRelation(root, relationProfile(), { type: "tests", from: IDEA, to: IDEA });
    await expect(bad).rejects.toBeInstanceOf(RelationWriteDeniedError);
    await expect(readRelations(root)).resolves.toMatchObject({ relations: [] });
  });

  it("plans+writes a symmetric edge in reverse lexical order (planner agrees with the store)", async () => {
    const symProfile = {
      ...RESEARCH_LITE_PROFILE,
      relations: { peers: { from: ["experiments"], to: ["ideas"], direction: "symmetric" } },
    } as ProfilePack;
    // ideas/... sorts before experiments/..., so the planner judges the CANONICAL
    // (swapped) endpoints — a reversed symmetric write is allowed, not denied.
    const ref = await createRelation(root, symProfile, { type: "peers", from: IDEA, to: EXP });
    expect(ref.id).toMatch(/^rel_/);
    expect((await readRelations(root)).relations).toHaveLength(1);
  });
});

describe("transitionLifecycle (validated page update)", () => {
  it("updates the page frontmatter on disk for a legal transition", async () => {
    await transitionLifecycle(root, "ideas", "sparse-routing", "testing");
    const page = await readFile(path.join(root, "wiki/ideas/sparse-routing.md"), "utf8");
    expect(page).toContain("status: testing");
  });

  it("refuses an illegal transition via the PR2 gate, leaving the page unchanged", async () => {
    const bad = transitionLifecycle(root, "ideas", "sparse-routing", "validated");
    await expect(bad).rejects.toBeInstanceOf(LifecycleTransitionError);
    const page = await readFile(path.join(root, "wiki/ideas/sparse-routing.md"), "utf8");
    expect(page).toContain("status: proposed");
  });

  it("throws for an entity type with no lifecycle", async () => {
    const bad = transitionLifecycle(root, "experiments", "ablation-batch-size", "anything");
    await expect(bad).rejects.toBeInstanceOf(LifecycleTransitionUnavailableError);
  });
});
