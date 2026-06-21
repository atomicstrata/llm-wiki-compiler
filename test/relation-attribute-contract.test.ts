/**
 * @file test/relation-attribute-contract.test.ts
 * @description Write-path enforcement of relation ATTRIBUTE contracts (audit
 * FIX 2): a relation attribute is now run through the SAME field contract as an
 * entity field (type / enum / min/max), not just required-presence.
 *
 * Covers: a relation whose attribute violates its declared type, enum, or
 * min/max is rejected and nothing is appended — at BOTH the planner
 * ({@link planRelationMutation} → deny) and the store ({@link appendRelation} →
 * RelationEndpointError); a valid-attributes relation still appends; and an
 * UNDECLARED extra attribute is allowed (mirrors entity extra-frontmatter).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendRelation } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { RelationEndpointError } from "../src/relations/types.js";
import { planRelationMutation } from "../src/trust/relation-plan.js";
import { experimentsIdeasProfile, EXPERIMENT_A as EXP_A, IDEA_B } from "./fixtures/profile-fixtures.js";

/** A profile whose `tests` relation declares a bounded-number `confidence` + enum `kind`. */
const profile = () => experimentsIdeasProfile({
  tests: {
    from: ["experiments"], to: ["ideas"], direction: "directed",
    attributes: { confidence: { type: "number", min: 0, max: 1 }, kind: { type: "enum", enum: ["a", "b"] } },
    requiredAttributes: ["confidence"],
  },
});

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-attr-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const write = (attributes: Record<string, unknown>) =>
  appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes });

const plan = (attributes: Record<string, unknown>) =>
  planRelationMutation(profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes });

describe("relation attribute contract enforcement (FIX 2)", () => {
  it("store rejects a wrong-typed attribute and writes nothing", async () => {
    await expect(write({ confidence: "x" })).rejects.toThrow(RelationEndpointError);
    await expect(readRelations(root)).resolves.toMatchObject({ relations: [] });
  });

  it("store rejects an out-of-range number and a bad enum", async () => {
    await expect(write({ confidence: 2 })).rejects.toThrow(/exceeds max/);
    await expect(write({ confidence: 0.5, kind: "z" })).rejects.toThrow(/not one of/);
  });

  it("planner denies a contract-violating relation", () => {
    expect(plan({ confidence: "x" }).decision).toBe("deny");
  });

  it("appends a valid-attributes relation (extra undeclared attr allowed)", async () => {
    const ref = await write({ confidence: 0.5, kind: "a", note: "extra-ok" });
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].id).toBe(ref.id);
  });
});
