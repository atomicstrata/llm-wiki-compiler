/**
 * @file test/connectors/profile-binding.test.ts
 * @description Load-validation for pure-data connector profile bindings.
 */
import { describe, expect, it } from "vitest";
import { validateProfile } from "../../src/profile/validate.js";
import type { ProfilePack } from "../../src/profile/types.js";

function baseProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "connector-test",
    entities: {
      articles: {
        directory: "wiki/articles",
        fields: {
          headline: { type: "string", required: true },
        },
      },
    },
  };
}

describe("profile connectors block", () => {
  it("accepts a connector binding whose id, entity, and draft fields are declared", () => {
    const raw = {
      ...baseProfile(),
      connectors: {
        fixture: {
          entityType: "articles",
          fields: { headline: "headline" },
          contentField: "body",
        },
      },
    };

    expect(validateProfile(raw).profile.connectors?.fixture?.entityType).toBe("articles");
  });

  it("rejects an undeclared connector id", () => {
    const raw = {
      ...baseProfile(),
      connectors: { nope: { entityType: "articles", fields: { headline: "headline" } } },
    };

    expect(() => validateProfile(raw)).toThrow(/connector 'nope' is not registered/);
  });

  it("rejects a binding to an undeclared entity type", () => {
    const raw = {
      ...baseProfile(),
      connectors: { fixture: { entityType: "ideas", fields: { headline: "headline" } } },
    };

    expect(() => validateProfile(raw)).toThrow(/connector 'fixture' entityType 'ideas' is not declared/);
  });

  it("rejects a connector draft field not emitted by the connector", () => {
    const raw = {
      ...baseProfile(),
      connectors: { fixture: { entityType: "articles", fields: { bogus: "headline" } } },
    };

    expect(() => validateProfile(raw)).toThrow(/draft field 'bogus' is not emitted by connector 'fixture'/);
  });

  it("rejects a mapping to an undeclared entity field", () => {
    const raw = {
      ...baseProfile(),
      connectors: { fixture: { entityType: "articles", fields: { headline: "missing" } } },
    };

    expect(() => validateProfile(raw)).toThrow(/entity field 'missing' is not declared/);
  });
});
