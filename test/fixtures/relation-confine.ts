/**
 * @file test/fixtures/relation-confine.ts
 * @description Shared scaffolding for the relation-store confinement suites
 * (graph-DIR confinement and store-FILE-leaf no-follow). Both suites use the
 * same directed-`tests` profile, the same `experiments/a -> ideas/b` append, and
 * the same "a normal real-file store still appends + reads" regression. Hoisting
 * them here removes the duplicated boilerplate (flagged by fallow) while each
 * suite keeps its own symlink-planting and fail-closed assertions local.
 */

import { expect } from "vitest";
import type { ProfilePack } from "../../src/profile/types.js";
import { appendRelation } from "../../src/relations/store.js";
import { readRelations } from "../../src/relations/store-read.js";
import { experimentsIdeasProfile, EXPERIMENT_A, IDEA_B } from "./profile-fixtures.js";

/** A non-default profile carrying a single directed `experiments -> ideas` `tests` relation. */
export function relationConfineProfile(): ProfilePack {
  return experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });
}

/** Append the canonical `experiments/a -> ideas/b` `tests` relation under `root`. */
export function appendTestRelation(root: string): ReturnType<typeof appendRelation> {
  return appendRelation(root, relationConfineProfile(), { type: "tests", from: EXPERIMENT_A, to: IDEA_B, attributes: {} });
}

/**
 * Assert the happy path on a NORMAL (real-file) store: the append persists and a
 * read returns exactly that one relation. The shared regression both confinement
 * suites run so a hardening change can never silently break the normal path.
 *
 * @param root - The in-project temp root to append + read under.
 */
export async function expectNormalAppendAndRead(root: string): Promise<void> {
  const ref = await appendTestRelation(root);
  const { relations } = await readRelations(root);
  expect(relations).toHaveLength(1);
  expect(relations[0].id).toBe(ref.id);
}
