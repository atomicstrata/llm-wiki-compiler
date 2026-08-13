/**
 * @file test/profile-field-format-validate.test.ts
 * @description `FieldDef.format` — the minimal declarative link vocabulary.
 *
 * The schema could not tell an ordinary string from a URL, a DOI, or an arXiv
 * id, so a read surface had no way to link one without knowing what `doi` means
 * — which is precisely the domain knowledge core code may not carry.
 *
 * A CLOSED enum rather than an author-supplied URL template. A template would be
 * a string a renderer interpolates into an href, i.e. executable profile
 * behaviour reaching a read surface, and the point of the field is presentation
 * metadata. An unknown value fails validation rather than degrading silently:
 * `$defs/fieldDef` is `additionalProperties: false`, so fail-closed is the house
 * default here, not an extra decision.
 *
 * Restricted to `string`/`string[]`: a format is a hint about how to read TEXT.
 * On a boolean, a number, a date or an artifactRef it would be config no
 * renderer could act on, so it is rejected at load rather than ignored later.
 */

import { describe, expect, it } from "vitest";
import { validateProfileShape } from "../src/profile/validate.js";
import type { FieldDef, ProfilePack } from "../src/profile/types.js";

/** A pack whose `papers.locator` field carries the given definition. */
function packWith(locator: FieldDef): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { papers: { directory: "wiki/papers", fields: { locator } } },
  };
}

/** Validate a pack whose `locator` carries `field`, returning the thrown error's message. */
function messageFor(field: Record<string, unknown>): string {
  try {
    validateProfileShape(packWith(field as unknown as FieldDef));
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("FieldDef.format accepts the declared vocabulary", () => {
  it("accepts each format on a string field", () => {
    for (const format of ["url", "doi", "arxiv"] as const) {
      expect(() => validateProfileShape(packWith({ type: "string", format }))).not.toThrow();
    }
  });

  it("accepts a format on a string[] field", () => {
    expect(() => validateProfileShape(packWith({ type: "string[]", format: "url" }))).not.toThrow();
  });

  it("still accepts a field declaring no format at all", () => {
    expect(() => validateProfileShape(packWith({ type: "string" }))).not.toThrow();
  });

  it("still accepts a non-text field, so long as it declares no format", () => {
    expect(() => validateProfileShape(packWith({ type: "boolean" }))).not.toThrow();
  });
});

describe("FieldDef.format is fail-closed", () => {
  it("rejects an unknown format rather than ignoring it", () => {
    expect(messageFor({ type: "string", format: "isbn" })).toMatch(/format/i);
  });

  it("rejects a format on a field type it cannot describe", () => {
    for (const type of ["boolean", "number", "integer", "date", "enum", "artifactRef"]) {
      expect(messageFor({ type, format: "url" }), type).toMatch(/format/i);
    }
  });

  it("names the offending entity and field, not just the rule", () => {
    const message = messageFor({ type: "boolean", format: "url" });
    expect(message).toContain("papers");
    expect(message).toContain("locator");
  });
});

/**
 * The schema resolves relation `attributes` and artifact `metadata` to the same
 * `$defs/fieldDef`, so all three carriers accept the key. The contract says
 * text-only, and artifact metadata is projected onto the wire — so the check has
 * to sit on every carrier, the way `assertArtifactTypesScoped` already does.
 */
describe("the rule covers every FieldDef carrier, not just entity fields", () => {
  it("rejects a badly typed format on a relation attribute", () => {
    const pack: ProfilePack = {
      schemaVersion: 1,
      profileId: "research",
      entities: { papers: { directory: "wiki/papers" }, sources: { directory: "wiki/sources" } },
      relations: {
        cites: {
          from: ["papers"],
          to: ["sources"],
          direction: "directed",
          attributes: { score: { type: "number", format: "doi" } as unknown as FieldDef },
        },
      },
    };
    expect(() => validateProfileShape(pack)).toThrow(/format/i);
  });

  it("rejects a badly typed format on artifact metadata", () => {
    const pack: ProfilePack = {
      schemaVersion: 1,
      profileId: "research",
      entities: { papers: { directory: "wiki/papers" } },
      artifacts: {
        result: {
          fileName: "result.json",
          contentKind: "json",
          maxBytes: 1024,
          metadata: { verified: { type: "boolean", format: "url" } as unknown as FieldDef },
        },
      },
    };
    expect(() => validateProfileShape(pack)).toThrow(/format/i);
  });

  it("accepts a well-typed format on both carriers", () => {
    const pack: ProfilePack = {
      schemaVersion: 1,
      profileId: "research",
      entities: { papers: { directory: "wiki/papers" }, sources: { directory: "wiki/sources" } },
      relations: {
        cites: {
          from: ["papers"],
          to: ["sources"],
          direction: "directed",
          attributes: { via: { type: "string", format: "url" } },
        },
      },
      artifacts: {
        result: {
          fileName: "result.json",
          contentKind: "json",
          maxBytes: 1024,
          metadata: { source: { type: "string", format: "url" } },
        },
      },
    };
    expect(() => validateProfileShape(pack)).not.toThrow();
  });
});
