/**
 * @file test/profile-relation-requirements-validate.test.ts
 * @description Tests for the optional `transitionRelationRequirements` lifecycle
 * block and its fail-closed LOAD validation.
 *
 * A relation-count precondition declares that, before ENTERING a lifecycle state,
 * the entity must be an endpoint of at least `minCount` instances of a declared
 * relation type on a given `role` side (optionally narrowed to `otherTypes` on the
 * opposite side, and/or to `otherStates` the other endpoint must currently sit
 * in). These tests pin: a well-formed block passes `validateProfileShape`; each
 * of the rejection rules fails the LOAD (unknown state; undeclared relationType;
 * bad role; role on a symmetric relation; this entity not a legal role-side
 * endpoint; illegal/empty otherTypes; non-integer/`< 1` minCount; and an
 * `otherStates` that is empty, duplicated, undeclared, or unsatisfiable); and an
 * omitted block (or a lifecycle carrying only the existing
 * `transitionRequirements`) is unaffected (omitted-for-default).
 */

import { describe, it, expect } from "vitest";
import { validateProfileShape, ProfileValidationError } from "../src/profile/validate.js";
import type { ProfilePack, RelationCountReq } from "../src/profile/types.js";

/**
 * A minimal research-like profile: `experiments` (with a lifecycle) and `ideas`,
 * plus a directed `tests` relation (experiments -> ideas) and a `symmetric`
 * `related` relation. A `req` overrides the `complete`-state precondition.
 */
function relReqProfile(req?: RelationCountReq): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      ideas: { directory: "wiki/ideas" },
      experiments: {
        directory: "wiki/experiments",
        lifecycle: {
          field: "stage",
          initial: "designed",
          terminal: ["complete"],
          transitions: { designed: ["running"], running: ["complete"] },
          transitionRelationRequirements: {
            complete: [req ?? { relationType: "tests", role: "from", otherTypes: ["ideas"], minCount: 1 }],
          },
        },
      },
    },
    relations: {
      tests: { from: ["experiments"], to: ["ideas"], direction: "directed" },
      related: { from: ["experiments"], to: ["ideas"], direction: "symmetric" },
    },
  };
}

describe("validateProfileShape — transitionRelationRequirements (happy path)", () => {
  it("accepts a well-formed relation-count precondition", () => {
    const result = validateProfileShape(relReqProfile());
    const lc = result.profile.entities.experiments.lifecycle;
    expect(lc?.transitionRelationRequirements?.complete).toHaveLength(1);
  });

  it("accepts an omitted otherTypes (means any opposite type)", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", minCount: 2 });
    expect(() => validateProfileShape(raw)).not.toThrow();
  });

  it("accepts a profile with NO transitionRelationRequirements (omitted-for-default)", () => {
    const raw = relReqProfile();
    delete raw.entities.experiments.lifecycle!.transitionRelationRequirements;
    expect(() => validateProfileShape(raw)).not.toThrow();
  });

  it("leaves an existing transitionRequirements-only lifecycle unaffected", () => {
    const raw = relReqProfile();
    const lc = raw.entities.experiments.lifecycle!;
    delete lc.transitionRelationRequirements;
    lc.transitions.running = ["complete"];
    raw.entities.experiments.fields = { note: { type: "string" } };
    lc.transitionRequirements = { complete: ["note"] };
    expect(() => validateProfileShape(raw)).not.toThrow();
  });
});

describe("validateProfileShape — transitionRelationRequirements (fail closed)", () => {
  it("rule 1: rejects an undeclared lifecycle state key", () => {
    const raw = relReqProfile();
    const lc = raw.entities.experiments.lifecycle!;
    lc.transitionRelationRequirements = { archived: [{ relationType: "tests", role: "from", minCount: 1 }] };
    expect(() => validateProfileShape(raw)).toThrow(/unknown state 'archived'/);
  });

  it("rule 2: rejects an undeclared relationType", () => {
    const raw = relReqProfile({ relationType: "nope", role: "from", minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/not a declared relation type/);
  });

  it("rule 3: rejects an invalid role", () => {
    const raw = relReqProfile({ relationType: "tests", role: "sideways" as "from", minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("rule 4: rejects a role on a symmetric relation type", () => {
    const raw = relReqProfile({ relationType: "related", role: "from", minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/symmetric relation type 'related'/);
  });

  it("rule 5: rejects this entity not being a legal role-side endpoint", () => {
    // `tests` has experiments on `from`, ideas on `to`; role "to" is illegal for experiments.
    const raw = relReqProfile({ relationType: "tests", role: "to", minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/is not a legal 'to'-side endpoint/);
  });

  it("rule 6: rejects an otherTypes entry that is not a legal opposite-side endpoint", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", otherTypes: ["experiments"], minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/not a legal opposite-side endpoint/);
  });

  it("rule 6: rejects an undeclared otherTypes entity type", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", otherTypes: ["ghosts"], minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/not a declared entity type/);
  });

  it("rule 6: rejects an empty otherTypes list", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", otherTypes: [], minCount: 1 });
    expect(() => validateProfileShape(raw)).toThrow(/empty 'otherTypes'/);
  });

  it("rule 7: rejects minCount of 0", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", minCount: 0 });
    expect(() => validateProfileShape(raw)).toThrow(/minCount must be a finite integer >= 1/);
  });

  it("rule 7: rejects a negative minCount", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", minCount: -3 });
    expect(() => validateProfileShape(raw)).toThrow(/minCount must be a finite integer >= 1/);
  });

  it("rule 7: rejects a non-integer minCount", () => {
    const raw = relReqProfile({ relationType: "tests", role: "from", minCount: 1.5 });
    expect(() => validateProfileShape(raw)).toThrow(/minCount must be a finite integer >= 1/);
  });

  it("rule 7: rejects an Infinity minCount (fails the load)", () => {
    // ajv's strict number gate catches Infinity structurally; the semantic
    // integer check backstops it. Either way the profile LOAD fails closed.
    const raw = relReqProfile({ relationType: "tests", role: "from", minCount: Number.POSITIVE_INFINITY });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });
});

/** {@link relReqProfile} with a LIFECYCLE on `ideas` (`phase: open → closed`) so an `otherStates` filter is satisfiable. */
function statefulIdeasProfile(req: RelationCountReq): ProfilePack {
  const raw = relReqProfile(req);
  raw.entities.ideas = {
    directory: "wiki/ideas",
    fields: { phase: { type: "enum", enum: ["open", "closed"] } },
    lifecycle: { field: "phase", initial: "open", terminal: ["closed"], transitions: { open: ["closed"] } },
  };
  return raw;
}

describe("validateProfileShape — otherStates (rule 8)", () => {
  const req = (otherStates: string[]): RelationCountReq => ({ relationType: "tests", role: "from", otherTypes: ["ideas"], otherStates, minCount: 1 });

  it("accepts an otherStates naming declared lifecycle states of an allowed other type", () => {
    expect(() => validateProfileShape(statefulIdeasProfile(req(["open", "closed"])))).not.toThrow();
  });

  it("rejects an otherStates entry that is not a declared lifecycle state of any allowed other type", () => {
    expect(() => validateProfileShape(statefulIdeasProfile(req(["bogus"])))).toThrow(/otherStates entry 'bogus'/);
  });

  it("rejects an empty otherStates list", () => {
    expect(() => validateProfileShape(statefulIdeasProfile(req([])))).toThrow(/empty 'otherStates'/);
  });

  it("rejects duplicate otherStates entries", () => {
    expect(() => validateProfileShape(statefulIdeasProfile(req(["open", "open"])))).toThrow(/duplicate 'otherStates'/);
  });

  it("rejects otherStates when NO allowed other endpoint type declares a lifecycle (unsatisfiable)", () => {
    // The base fixture's `ideas` has no lifecycle, so the filter can never match.
    expect(() => validateProfileShape(relReqProfile(req(["open"])))).toThrow(/unsatisfiable/);
  });
});
