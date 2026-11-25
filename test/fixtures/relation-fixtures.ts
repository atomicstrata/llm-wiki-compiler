/**
 * @file test/fixtures/relation-fixtures.ts
 * @description Relation-store helpers for the research-lite profile fixtures:
 * build an attribute writer, seed and check a three-version compaction
 * scenario.
 *
 * Split from `profile-fixtures.ts`, which most profile tests import for data
 * alone: the relation store and its dependencies load only in the tests that
 * write relations. Bun loads each test file's import graph afresh.
 *
 * Re-exports: the store functions are re-exported so the relation-contract test
 * files can import shared helpers + store functions from one import line,
 * keeping their import blocks structurally distinct.
 */

import { expect } from "bun:test";
import type { ProfilePack } from "../../src/profile/types.js";
import { appendRelation, updateRelation } from "../../src/relations/store.js";
import { readRelations } from "../../src/relations/store-read.js";
import { EXPERIMENT_A, IDEA_B } from "./profile-fixtures.js";

export { appendRelation, updateRelation, compactRelations } from "../../src/relations/store.js";
export { readRelations } from "../../src/relations/store-read.js";

/**
 * Factory that returns a `write` helper bound to the caller's mutable `root`
 * and profile. Shared by the relation-attribute-contract and
 * relation-required-undefined test files so they don't each define the same
 * `write = (attributes) => appendRelation(root, profile(), {...})` closure.
 *
 * @param getRoot - Returns the current test `root` (closure over mutable variable).
 * @param getProfile - Returns the profile under test.
 */
export function makeRelationWriter(
  getRoot: () => string,
  getProfile: () => ProfilePack,
): (attributes: Record<string, unknown>) => Promise<{ id: string; type: string }> {
  return (attributes) =>
    appendRelation(getRoot(), getProfile(), { type: "tests", from: EXPERIMENT_A, to: IDEA_B, attributes });
}

/**
 * Seed a 3-version compaction scenario: append `{a:"1"}`, update to `{a:"2"}`,
 * update to `{a:"3"}`. Returns the relation id for callers that call
 * `compactRelations` themselves. Shared by the compaction-confine and
 * store-audit tests to avoid repeating the 3-step append+update sequence.
 *
 * @param root - Project root.
 * @param profile - Profile declaring the `tests` relation.
 * @returns The relation id of the seeded record.
 */
export async function seedThreeVersionRelation(root: string, profile: ProfilePack): Promise<string> {
  const ref = await appendRelation(root, profile, { type: "tests", from: EXPERIMENT_A, to: IDEA_B, attributes: { a: "1" } });
  await updateRelation(root, profile, ref.id, { attributes: { a: "2" } });
  await updateRelation(root, profile, ref.id, { attributes: { a: "3" } });
  return ref.id;
}

/**
 * Assert that a just-compacted store shrank and the sole surviving record has
 * `{a:"3"}`. Shared by the compaction-confine and store-audit tests so they
 * don't each repeat the same readRelations + expect block.
 *
 * @param root - Project root.
 * @param result - The `{before, after}` result from `compactRelations`.
 */
export async function assertCompactionShrankTo3(
  root: string,
  result: { before: number; after: number },
): Promise<void> {
  expect(result.after).toBeLessThan(result.before);
  const { relations } = await readRelations(root);
  expect(relations).toHaveLength(1);
  expect(relations[0].attributes).toEqual({ a: "3" });
}
