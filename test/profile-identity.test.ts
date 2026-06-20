/**
 * Tests for the branded identity primitives.
 *
 * These constructors validate rather than transform: a raw filesystem stem
 * is returned verbatim, only slug-safe strings can become a SlugSafe, and the
 * single mint site for EntityId rejects unsafe halves. suggestSlugFromBasename
 * is the one place slugify is applied, and only for error-message hints.
 */

import { describe, it, expect } from "vitest";
import {
  isSlugSafe,
  assertSlugSafe,
  entityId,
  parseEntityId,
  stemFromBasename,
  suggestSlugFromBasename,
  assertSlugMatchesFrontmatter,
  EntityIdError,
} from "../src/profile/identity.js";

describe("entityId / parseEntityId", () => {
  it("composes a type/slug id and parses it back on the first slash", () => {
    const id = entityId("papers", "foo-bar");
    expect(id).toBe("papers/foo-bar");
    expect(parseEntityId(id)).toEqual({ entityType: "papers", slug: "foo-bar" });
  });

  it("splits on the FIRST slash, keeping later slashes in the type-less remainder", () => {
    const id = entityId("nested", "a-b-c");
    expect(parseEntityId(id)).toEqual({ entityType: "nested", slug: "a-b-c" });
  });

  it("throws when a slug half is not slug-safe", () => {
    expect(() => entityId("Papers", "x")).toThrow(EntityIdError);
  });

  it("parses a well-formed type/slug id", () => {
    expect(parseEntityId("concepts/rag" as EntityId)).toEqual({
      entityType: "concepts",
      slug: "rag",
    });
  });

  it("rejects a traversal entityType so a hand-built id cannot escape the namespace", () => {
    expect(() => parseEntityId("../evil" as EntityId)).toThrow(EntityIdError);
  });

  it("rejects a leading-slash id (empty entityType)", () => {
    expect(() => parseEntityId("/evil" as EntityId)).toThrow(EntityIdError);
  });

  it("rejects an id with no slash (not <type>/<slug>)", () => {
    expect(() => parseEntityId("noslash" as EntityId)).toThrow(EntityIdError);
  });

  it("rejects an uppercase (non-slug-safe) entityType", () => {
    expect(() => parseEntityId("Concepts/rag" as EntityId)).toThrow(EntityIdError);
  });
});

describe("stemFromBasename", () => {
  it("returns the raw stem verbatim, with spaces preserved", () => {
    expect(stemFromBasename("wiki/papers/Foo Bar.md")).toBe("Foo Bar");
  });

  it("returns non-Latin stems verbatim", () => {
    expect(stemFromBasename("wiki/papers/研究.md")).toBe("研究");
  });
});

describe("isSlugSafe / assertSlugSafe", () => {
  it("rejects strings with spaces or uppercase", () => {
    expect(isSlugSafe("Foo Bar")).toBe(false);
  });

  it("accepts a lowercase hyphenated slug", () => {
    expect(isSlugSafe("foo-bar")).toBe(true);
  });

  it("assertSlugSafe throws on an unsafe slug", () => {
    expect(() => assertSlugSafe("Foo Bar")).toThrow(EntityIdError);
  });
});

describe("suggestSlugFromBasename", () => {
  it("slugifies the basename stem for error hints", () => {
    expect(suggestSlugFromBasename("wiki/papers/Foo Bar.md")).toBe("foo-bar");
  });
});

describe("assertSlugMatchesFrontmatter", () => {
  it("passes when no slug is declared", () => {
    expect(() => assertSlugMatchesFrontmatter("foo", undefined)).not.toThrow();
  });

  it("passes when the declared slug matches the stem", () => {
    expect(() => assertSlugMatchesFrontmatter("foo", "foo")).not.toThrow();
  });

  it("throws when the declared slug disagrees with the stem", () => {
    expect(() => assertSlugMatchesFrontmatter("foo", "bar")).toThrow(EntityIdError);
  });
});
