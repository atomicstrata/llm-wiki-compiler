/**
 * @file test/relation-required-undefined.test.ts
 * @description Fail-closed coverage for audit FIX F2: a REQUIRED field/attribute
 * explicitly set to `undefined` must be rejected, not accepted.
 *
 * Before the fix, the required check used only `field in values`, so an own key
 * present but valued `undefined` (e.g. a JS attributes object
 * `{rationale: undefined}` on the SDK/runtime path) PASSED the required check —
 * yet `JSON.stringify`/canonicalize DROP an `undefined` value, so the persisted
 * record was MISSING its required field while being reported valid.
 *
 * Covers the runtime/SDK relation write path (`appendRelation`) and the shared
 * entity-field validator (`validateEntityFields`): a required name valued
 * `undefined` is rejected; a real value is accepted; an OPTIONAL declared field
 * valued `undefined` is accepted (the key is dropped consistently on persist).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RelationEndpointError } from "../src/relations/types.js";
import { validateEntityFields } from "../src/profile/field-contract.js";
import type { EntityTypeDef } from "../src/profile/types.js";
import {
  experimentsIdeasProfile,
  readRelations, makeRelationWriter,
} from "./fixtures/profile-fixtures.js";

/** A `tests` relation declaring a REQUIRED `confidence` and an OPTIONAL `kind`. */
const profile = () => experimentsIdeasProfile({
  tests: {
    from: ["experiments"], to: ["ideas"], direction: "directed",
    attributes: { confidence: { type: "number", min: 0, max: 1 }, kind: { type: "string" } },
    requiredAttributes: ["confidence"],
  },
});

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-req-undef-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const write = makeRelationWriter(() => root, profile);

describe("FIX F2 — required attribute/field set to undefined fails closed", () => {
  it("rejects a required relation attribute valued undefined and appends nothing", async () => {
    await expect(write({ confidence: undefined })).rejects.toThrow(RelationEndpointError);
    await expect(readRelations(root)).resolves.toMatchObject({ relations: [] });
  });

  it("accepts a required attribute with a real value", async () => {
    const ref = await write({ confidence: 0.5 });
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].id).toBe(ref.id);
  });

  it("accepts an OPTIONAL declared attribute valued undefined (key dropped on persist)", async () => {
    const ref = await write({ confidence: 0.5, kind: undefined });
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].id).toBe(ref.id);
    expect("kind" in relations[0].attributes).toBe(false);
  });

  it("shared entity-field validator rejects a required field valued undefined", () => {
    const def: EntityTypeDef = { directory: "experiments", requiredFields: ["title"], fields: { title: { type: "string" } } };
    expect(validateEntityFields({ title: undefined }, def)).toHaveLength(1);
    expect(validateEntityFields({ title: "ok" }, def)).toEqual([]);
  });
});
