/**
 * @file test/profile-title-field.test.ts
 * @description `EntityTypeDef.titleField` — the declaration that decides which
 * frontmatter key holds a typed page's display title.
 *
 * The field has been in the profile schema since the format shipped and was
 * consumed NOWHERE: the collector read the literal `title` key, so a type whose
 * display name lives under another key (AutoSci's `people`, keyed `name`) had no
 * title at all and every read surface fell back to its slug.
 *
 * Resolution belongs in the COLLECTOR rather than in one reader, so every
 * surface that renders a display title reads one declaration one way: the
 * viewer, context packs, index generation and the JSON export. A viewer-only fix
 * would give a single declaration two meanings, which is the dual-source problem
 * this codebase keeps removing. Lint and the OKF export deliberately read the
 * literal key instead, which `profile-title-field-blast-radius.test.ts` pins.
 *
 * Scope is deliberately narrow, and these tests pin all three edges of it: the
 * declared field is read when `titleField` is present; the literal `title` key
 * still wins when it is omitted; and an absent VALUE leaves the title undefined
 * so every existing slug fallback downstream behaves exactly as before.
 */

import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { collectEntityPages } from "../src/profile/collect.js";
import { validateProfileShape } from "../src/profile/validate.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import type { EntityTypeDef, ProfilePack } from "../src/profile/types.js";

/**
 * A pack whose `people` type titles by `name` and whose `desks` type declares no
 * `titleField` at all — the before-and-after cases in one profile.
 */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "newsroom",
  entities: {
    people: {
      directory: "wiki/people",
      titleField: "name",
      fields: { name: { type: "string" }, affiliation: { type: "string" } },
    },
    desks: { directory: "wiki/desks", fields: { title: { type: "string" } } },
  },
};

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

/** Seed one page under `directory` and return the collected page for `slug`. */
async function collectOne(directory: string, slug: string, frontmatter: string) {
  const root = await makeTempRoot("profile-title-field");
  roots.push(root);
  await writeMarkdownPage(root, directory, slug, `---\n${frontmatter}\n---\n\nBody.`);
  const { pages } = await collectEntityPages(root, PROFILE);
  return pages.find((page) => page.slug === slug);
}

describe("a typed page's title comes from its declared titleField", () => {
  it("reads the declared field rather than the literal `title` key", async () => {
    const page = await collectOne("wiki/people", "ada", "name: Ada Lovelace");
    expect(page?.title).toBe("Ada Lovelace");
  });

  it("still reads `title` for a type that declares no titleField", async () => {
    const page = await collectOne("wiki/desks", "tech", "title: Tech Desk");
    expect(page?.title).toBe("Tech Desk");
  });

  it("ignores a literal `title` key when the type titles by another field", async () => {
    const page = await collectOne("wiki/people", "ada", "name: Ada Lovelace\ntitle: Countess");
    expect(page?.title).toBe("Ada Lovelace");
  });
});

describe("an unusable titleField value leaves the title undefined", () => {
  // Every read surface already falls back to the slug on an undefined title.
  // Returning undefined rather than an empty or coerced string is what keeps
  // that fallback — and the existing `missing_title` semantics — unchanged.
  it("leaves it undefined when the declared field is absent from the page", async () => {
    const page = await collectOne("wiki/people", "ada", "affiliation: Analytical Engine Co");
    expect(page?.title).toBeUndefined();
  });

  it("leaves it undefined when the declared field holds only whitespace", async () => {
    const page = await collectOne("wiki/people", "ada", 'name: "   "');
    expect(page?.title).toBeUndefined();
  });

  it("trims the resolved title rather than carrying padding to every surface", async () => {
    const page = await collectOne("wiki/people", "ada", 'name: "   Ada Lovelace   "');
    expect(page?.title).toBe("Ada Lovelace");
  });

  // Validation rejects a titleField naming an inherited property, so reaching
  // the collector with one means an unvalidated profile — the SDK, or a test.
  // `Object.prototype.constructor` resolves to a FUNCTION, so the `string` test
  // is what turns it into an absent title; this pins that, not a guard.
  it("leaves it undefined when the declared field names an inherited property", async () => {
    const root = await makeTempRoot("profile-title-field");
    roots.push(root);
    await writeMarkdownPage(root, "wiki/people", "ada", "---\naffiliation: none\n---\n\nBody.");
    const unvalidated: ProfilePack = {
      schemaVersion: 1,
      profileId: "newsroom",
      entities: {
        people: {
          directory: "wiki/people",
          titleField: "constructor",
          fields: { affiliation: { type: "string" } },
        },
      },
    };
    const { pages } = await collectEntityPages(root, unvalidated);
    expect(pages[0]?.title).toBeUndefined();
  });

  it("leaves it undefined when the declared field holds a non-string", async () => {
    const page = await collectOne("wiki/people", "ada", "name: 42");
    expect(page?.title).toBeUndefined();
  });

  it("still collects the page — an untitled page is not an invalid one", async () => {
    const page = await collectOne("wiki/people", "ada", "affiliation: Analytical Engine Co");
    expect(page?.id).toBe("people/ada");
  });
});

/** A pack whose `people.titleField` is whatever the caller names. */
function packTitledBy(titleField: string, fields?: EntityTypeDef["fields"]): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "newsroom",
    entities: {
      people: {
        directory: "wiki/people",
        titleField,
        fields: fields ?? { name: { type: "string" }, active: { type: "boolean" } },
      },
    },
  };
}

describe("titleField is validated against the fields it claims to name", () => {
  // It was schema-typed as a bare string and checked against nothing, so a
  // profile could title by a field it never declared and load clean — the page
  // would then silently show its slug with no diagnostic anywhere.
  it("accepts a declared string field", () => {
    expect(() => validateProfileShape(packTitledBy("name"))).not.toThrow();
  });

  it("rejects a field the type does not declare", () => {
    expect(() => validateProfileShape(packTitledBy("headline"))).toThrow(/titleField/);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "reports %s as undeclared rather than as a mistyped field",
    (inherited) => {
      // A bare index resolved these off Object.prototype, so the undeclared
      // check passed and the type check rejected them as "not 'undefined'" —
      // the right outcome reported as the wrong problem.
      expect(() => validateProfileShape(packTitledBy(inherited))).toThrow(
        /is not a declared field/,
      );
    },
  );

  it("rejects a declared field that cannot hold a title", () => {
    expect(() => validateProfileShape(packTitledBy("active"))).toThrow(/titleField/);
  });

  it("rejects a titleField on a type declaring no fields at all", () => {
    expect(() => validateProfileShape(packTitledBy("name", {}))).toThrow(/titleField/);
  });

  it("still accepts a type that declares no titleField", () => {
    const pack: ProfilePack = {
      schemaVersion: 1,
      profileId: "newsroom",
      entities: { desks: { directory: "wiki/desks", fields: { title: { type: "string" } } } },
    };
    expect(() => validateProfileShape(pack)).not.toThrow();
  });
});
