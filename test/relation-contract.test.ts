/**
 * @file test/relation-contract.test.ts
 * @description Unit tests for the shared relation-contract validators (audit
 * FIX 2 + FIX 4) and the lifecycle-deletion gate (FIX 3) — pure, no I/O.
 *
 * Covers: relation attributes validated against the declared FieldDef contract
 * (type/enum/min/max), required-presence, extra-attribute tolerance; a stored
 * relation re-validated against the CURRENT profile (type removed / endpoint
 * disallowed / attribute now invalid); and that removing a lifecycle field from
 * an ENROLLED page is rejected while a never-enrolled create stays exempt.
 */

import { describe, it, expect } from "vitest";
import {
  validateRelationAttributes,
  validateRelationAgainstProfile,
} from "../src/relations/relation-contract.js";
import { validateLifecycleTransition } from "../src/profile/lifecycle.js";
import type { EntityId, LifecycleDef, RelationTypeDef } from "../src/profile/types.js";
import type { RelationRef } from "../src/relations/types.js";
import { experimentsIdeasProfile } from "./fixtures/profile-fixtures.js";

/** A relation-type def with a bounded-number `confidence` and an enum `kind`. */
const REL_DEF: RelationTypeDef = {
  from: ["experiments"],
  to: ["ideas"],
  direction: "directed",
  attributes: {
    confidence: { type: "number", min: 0, max: 1 },
    kind: { type: "enum", enum: ["a", "b"] },
  },
  requiredAttributes: ["confidence"],
};

/** A profile whose `tests` relation matches {@link REL_DEF}. */
const profile = () => experimentsIdeasProfile({ tests: REL_DEF });

/** A stored relation ref of type `tests` with the given attributes. */
function ref(attributes: Record<string, unknown>): RelationRef {
  return {
    id: "rel_x", type: "tests",
    from: "experiments/a" as EntityId, to: "ideas/b" as EntityId,
    attributes, contentHash: "h",
  };
}

describe("validateRelationAttributes (FIX 2)", () => {
  it("accepts valid attributes and tolerates extra undeclared ones", () => {
    expect(validateRelationAttributes(REL_DEF, { confidence: 0.5, extra: "ok" })).toEqual([]);
  });

  it("rejects a wrong-typed value, an out-of-range number, and a bad enum", () => {
    expect(validateRelationAttributes(REL_DEF, { confidence: "x" })[0]).toMatch(/not a valid number/);
    expect(validateRelationAttributes(REL_DEF, { confidence: 2 })[0]).toMatch(/exceeds max/);
    expect(validateRelationAttributes(REL_DEF, { confidence: 0.5, kind: "z" })[0]).toMatch(/not one of/);
  });

  it("reports a missing required attribute", () => {
    expect(validateRelationAttributes(REL_DEF, {})[0]).toMatch(/missing required attribute 'confidence'/);
  });
});

describe("validateRelationAgainstProfile (FIX 4)", () => {
  it("passes a still-valid stored relation", () => {
    expect(validateRelationAgainstProfile(ref({ confidence: 0.5 }), profile())).toEqual([]);
  });

  it("flags a relation whose type the profile no longer declares", () => {
    const p = profile();
    delete p.relations!.tests;
    expect(validateRelationAgainstProfile(ref({ confidence: 0.5 }), p)[0]).toMatch(/no longer declared/);
  });

  it("flags a relation whose attribute is now invalid under the profile", () => {
    expect(validateRelationAgainstProfile(ref({ confidence: 9 }), profile())[0]).toMatch(/exceeds max/);
  });
});

/** The research-lite `ideas` lifecycle FSM, abbreviated. */
const LIFECYCLE: LifecycleDef = {
  field: "status",
  initial: "proposed",
  terminal: ["validated"],
  transitions: { proposed: ["testing"], testing: ["validated"] },
};

describe("validateLifecycleTransition — deletion gate (FIX 3)", () => {
  it("rejects removing the field from an enrolled page", () => {
    const problems = validateLifecycleTransition(LIFECYCLE, "proposed", undefined, {});
    expect(problems[0]).toMatch(/cannot be removed from an enrolled page/);
  });

  it("allows a never-enrolled create with no lifecycle field", () => {
    expect(validateLifecycleTransition(LIFECYCLE, undefined, undefined, {})).toEqual([]);
  });

  it("still passes a legal transition", () => {
    expect(validateLifecycleTransition(LIFECYCLE, "proposed", "testing", { status: "testing" })).toEqual([]);
  });
});
