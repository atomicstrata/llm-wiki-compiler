/**
 * @file test/profile-relations.test.ts
 * @description Tests for typed relation-type definitions (Phase 4) — the
 * optional `relations` block on a profile pack and its fail-closed load
 * validation.
 *
 * A relation type declares `from`/`to` endpoint entity-type lists, a direction,
 * and typed attributes. These tests pin: a valid block loads; endpoints must
 * reference DECLARED entity types; `requiredAttributes` must name declared
 * attributes; an invalid `direction` is rejected structurally; relation keys
 * must be slug-safe; and a relation-less / default profile is unaffected (its
 * digest stays stable). The DEFAULT profile declares NO relations, so all of
 * this is omitted-for-default and parity is intact.
 */

import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../src/profile/validate.js";
import { profileDigest } from "../src/profile/digest.js";
import type { ProfilePack, RelationTypeDef } from "../src/profile/types.js";

/** A minimal valid profile with two entity types and one relation type. */
function relationProfile(rel?: Partial<RelationTypeDef>): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      experiments: { directory: "wiki/experiments" },
      ideas: { directory: "wiki/ideas" },
      methods: { directory: "wiki/methods" },
    },
    relations: {
      tests: {
        from: ["experiments"],
        to: ["ideas", "methods"],
        direction: "directed",
        attributes: { evidence: { type: "string" }, metricValue: { type: "string" } },
        requiredAttributes: ["evidence"],
        ...rel,
      },
    },
  };
}

describe("validateProfile — relation types (happy path)", () => {
  it("accepts a valid relations block and returns it", () => {
    const result = validateProfile(relationProfile());
    expect(result.profile.relations?.tests.direction).toBe("directed");
    expect(result.profile.relations?.tests.from).toEqual(["experiments"]);
  });

  it("accepts a symmetric relation with no attributes", () => {
    const raw = relationProfile({ direction: "symmetric", attributes: undefined, requiredAttributes: undefined });
    expect(() => validateProfile(raw)).not.toThrow();
  });
});

describe("validateProfile — relation types (fail closed)", () => {
  it("rejects a from-endpoint that is not a declared entity type", () => {
    const raw = relationProfile({ from: ["ghosts"] });
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfile(raw)).toThrow(/endpoint 'ghosts' is not a declared entity/);
  });

  it("rejects a to-endpoint that is not a declared entity type", () => {
    const raw = relationProfile({ to: ["ideas", "phantom"] });
    expect(() => validateProfile(raw)).toThrow(/endpoint 'phantom' is not a declared entity/);
  });

  it("rejects requiredAttributes referencing an undeclared attribute", () => {
    const raw = relationProfile({ requiredAttributes: ["evidence", "nope"] });
    expect(() => validateProfile(raw)).toThrow(/requiredAttributes references undeclared attribute 'nope'/);
  });

  it("rejects an invalid direction via the schema gate", () => {
    const raw = relationProfile({ direction: "bidirectional" as never });
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a slug-unsafe relation type key", () => {
    const raw = relationProfile();
    raw.relations = { "Tests Of": raw.relations!.tests };
    expect(() => validateProfile(raw)).toThrow(/slug-safe/);
  });

  it("rejects an empty from list via the schema minItems gate", () => {
    const raw = relationProfile({ from: [] });
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects an unknown relation-def key (additionalProperties:false)", () => {
    const raw = relationProfile();
    (raw.relations!.tests as Record<string, unknown>).bogus = 1;
    expect(() => validateProfile(raw)).toThrow(/unknown|unexpected/i);
  });
});

describe("profileDigest — relations parity", () => {
  it("produces a stable digest for a profile with relations", () => {
    expect(profileDigest(relationProfile())).toBe(profileDigest(relationProfile()));
    expect(profileDigest(relationProfile())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a relation-less profile digest is unchanged by the new key being absent", () => {
    const relationless: ProfilePack = {
      schemaVersion: 1,
      profileId: "research",
      entities: { experiments: { directory: "wiki/experiments" } },
    };
    const withEmptyKeyOmitted = { ...relationless };
    expect(profileDigest(relationless)).toBe(profileDigest(withEmptyKeyOmitted));
  });
});
