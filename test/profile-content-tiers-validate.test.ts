/**
 * @file test/profile-content-tiers-validate.test.ts
 * @description Load-validation for the additive `contentTiers` entity-type field.
 *
 * Each entry must be either a declared field of that entity type or the reserved
 * `body` token, and entries must be unique. An omitted or empty `contentTiers` is
 * valid (means "no projection"). These pin the fail-closed messages the validator
 * emits so a malformed depth projection is rejected at profile LOAD, not at read.
 */

import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../src/profile/validate.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A single-entity `widgets` profile whose `contentTiers` the caller sets. */
function widgetsProfile(contentTiers: string[]): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "widgets-test",
    entities: {
      widgets: {
        directory: "wiki/widgets",
        fields: { a: { type: "string" }, b: { type: "string" } },
        contentTiers,
      },
    },
  } as unknown as ProfilePack;
}

describe("validateProfile — contentTiers", () => {
  it("accepts declared-field entries and the reserved 'body' token", () => {
    expect(() => validateProfile(widgetsProfile(["a", "b", "body"]))).not.toThrow();
  });

  it("accepts an omitted contentTiers (no projection)", () => {
    const raw = widgetsProfile([]);
    delete (raw.entities.widgets as { contentTiers?: string[] }).contentTiers;
    expect(() => validateProfile(raw)).not.toThrow();
  });

  it("accepts an empty contentTiers", () => {
    expect(() => validateProfile(widgetsProfile([]))).not.toThrow();
  });

  it("rejects an entry that names an undeclared field", () => {
    expect(() => validateProfile(widgetsProfile(["a", "nope"]))).toThrow(ProfileValidationError);
    expect(() => validateProfile(widgetsProfile(["nope"]))).toThrow(
      /contentTiers entry 'nope' must be a declared field or the reserved 'body' token/,
    );
  });

  it("rejects a duplicate entry", () => {
    expect(() => validateProfile(widgetsProfile(["a", "a"]))).toThrow(
      /contentTiers has duplicate entry 'a'/,
    );
  });

  it("rejects a declared field named 'body' colliding with the reserved token", () => {
    const raw = widgetsProfile(["a", "body"]);
    (raw.entities.widgets as { fields: Record<string, unknown> }).fields.body = { type: "string" };
    expect(() => validateProfile(raw)).toThrow(
      /declares a field named 'body', which collides with the reserved contentTiers 'body' token/,
    );
  });
});
