/**
 * @file test/profile-evidence-type-compat.test.ts
 * @description FIX 4 — a transitionRequirements evidence field must have a TYPE
 * the runtime evidence gate (`isEvidencePresent`) can satisfy.
 *
 * `isEvidencePresent` accepts a non-empty string/number/slug/enum value or a
 * non-empty array of such scalars, and REJECTS booleans and objects. A profile
 * declaring a `boolean`-typed evidence field used to LOAD but the target state
 * could NEVER be entered (a permanently dead state). Validation now rejects an
 * evidence-incompatible type at LOAD with a clear message.
 */

import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../src/profile/validate.js";
import type { ProfilePack, FieldType } from "../src/profile/types.js";

/** A minimal valid profile with one declared evidence field of `type`. */
function profileWithEvidenceType(type: FieldType): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      papers: {
        directory: "wiki/papers",
        fields: {
          status: { type: "enum", enum: ["draft", "done"] },
          reason: { type, ...(type === "enum" ? { enum: ["a", "b"] } : {}) },
        },
        lifecycle: {
          field: "status",
          initial: "draft",
          terminal: ["done"],
          transitions: { draft: ["done"] },
          transitionRequirements: { done: ["reason"] },
        },
      },
    },
  };
}

describe("evidence-field type compatibility at load (FIX 4)", () => {
  it("rejects a boolean-typed evidence field", () => {
    expect(() => validateProfile(profileWithEvidenceType("boolean"))).toThrow(ProfileValidationError);
    expect(() => validateProfile(profileWithEvidenceType("boolean"))).toThrow(/can never satisfy/);
  });

  it("rejects a date-typed evidence field (gate cannot satisfy a Date value)", () => {
    expect(() => validateProfile(profileWithEvidenceType("date"))).toThrow(/can never satisfy/);
  });

  for (const t of ["string", "number", "integer", "slug", "string[]", "enum"] as const) {
    it(`accepts a ${t}-typed evidence field`, () => {
      expect(() => validateProfile(profileWithEvidenceType(t))).not.toThrow();
    });
  }
});
