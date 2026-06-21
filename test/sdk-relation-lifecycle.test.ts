/**
 * @file test/sdk-relation-lifecycle.test.ts
 * @description SDK-facade round-trip for the experimental trust-gated relation
 * write + lifecycle transition (Phase 4 PR5): `createWiki().createRelation` and
 * `.transitionLifecycle` on a profile project, the required-evidence refusal,
 * and the default-project guard.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { RelationsRequireProfileError } from "../src/trust/relation-write.js";
import { LifecycleTransitionError } from "../src/profile/lifecycle.js";
import { readRelations } from "../src/relations/store-read.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

const EXP = "experiments/ablation-batch-size" as EntityId;
const IDEA = "ideas/sparse-routing" as EntityId;

/** A research-lite profile with a `tests` relation + a `failed` evidence requirement. */
function profile(): ProfilePack {
  const ideas = RESEARCH_LITE_PROFILE.entities.ideas;
  return {
    ...RESEARCH_LITE_PROFILE,
    entities: {
      ...RESEARCH_LITE_PROFILE.entities,
      ideas: { ...ideas, lifecycle: { ...ideas.lifecycle, transitionRequirements: { failed: ["failureReason"] } } },
    },
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  } as ProfilePack;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sdk-rel-lc-"));
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile()), "utf8");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("createWiki() relation + lifecycle round-trip", () => {
  it("createRelation appends a relation visible via the store", async () => {
    const wiki = createWiki({ root });
    const ref = await wiki.createRelation({ type: "tests", from: EXP, to: IDEA });
    const { relations } = await readRelations(root);
    expect(relations).toMatchObject([{ id: ref.id, type: "tests", from: EXP, to: IDEA }]);
  });

  it("transitionLifecycle updates the page, then refuses missing required evidence", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "tested" });
    expect(await readFile(path.join(root, "wiki/ideas/sparse-routing.md"), "utf8")).toContain("status: tested");
    const bad = wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "failed" });
    await expect(bad).rejects.toBeInstanceOf(LifecycleTransitionError);
  });

  it("admits the transition once required evidence is supplied", async () => {
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "tested" });
    await wiki.transitionLifecycle({
      entityType: "ideas", slug: "sparse-routing", toState: "failed", evidence: { failureReason: "out of compute" },
    });
    const page = await readFile(path.join(root, "wiki/ideas/sparse-routing.md"), "utf8");
    expect(page).toContain("status: failed");
    expect(page).toContain("failureReason: out of compute");
  });
});

describe("default project guard", () => {
  it("createRelation throws RelationsRequireProfileError on a default project", async () => {
    const defaultRoot = await mkdtemp(path.join(os.tmpdir(), "sdk-rel-default-"));
    try {
      const wiki = createWiki({ root: defaultRoot });
      await expect(
        wiki.createRelation({ type: "tests", from: EXP, to: IDEA }),
      ).rejects.toBeInstanceOf(RelationsRequireProfileError);
    } finally {
      await rm(defaultRoot, { recursive: true, force: true });
    }
  });
});
