/**
 * @file test/profile-template-title-releases.test.ts
 * @description Both shipped non-default templates declare a `titleField` per
 * entity type at `0.2.0`, and both retain their `0.1.0` predecessor.
 *
 * Neither template could title a page before this. AutoSci's `people` carries
 * `name`; newsroom carries `headline`, `name` and `reporter` and declares no
 * `title` field at all — so every newsroom page showed its slug on every
 * surface.
 *
 * Retention is load-bearing rather than ceremonial. `planTemplateUpdate`
 * resolves the INSTALLED release and compares its `profileDigest` against the
 * on-disk profile to decide whether a project carries local modifications, so a
 * dropped `0.1.0` makes `planBuiltinTemplateUpdate` throw for every project
 * still on it, and a `0.1.0` that silently gained `titleField` would report
 * every genuine `0.1.0` install as modified.
 *
 * Each `0.1.0` entity block is DERIVED from `0.2.0` by dropping the title
 * declarations, which are the only difference between the releases. The digests
 * pinned below are the ones those releases actually published, computed from the
 * pre-change source — so they are an independent check on the derivation rather
 * than a restatement of it. A later edit that leaks into a retained release
 * fails here instead of quietly mis-describing an installed project.
 */

import { describe, expect, it } from "vitest";
import {
  getBuiltinTemplate,
  getBuiltinTemplateRelease,
  isShippedBuiltinProfile,
  listBuiltinTemplates,
} from "../src/profile/templates/registry.js";
import { profileDigest } from "../src/profile/digest.js";

/** The `profileDigest` each template's `0.1.0` published, computed pre-change. */
const PUBLISHED_0_1_0_DIGESTS: Record<string, string> = {
  autosci: "bf48a4e77f9f40e06d8c56514851e678c59dfa217e4542f38d0fc8ef5e9e5489",
  newsroom: "866882812c21c769e469d3f842b5bbdcc1d14cab4195cdb701d4c4181e4000ae",
};

/** The title field each template's types are expected to declare. */
const EXPECTED_TITLE_FIELDS: Record<string, Record<string, string>> = {
  newsroom: { articles: "headline", desks: "name", bylines: "reporter" },
  autosci: { people: "name", papers: "title", experiments: "title" },
};

const TEMPLATE_IDS = ["autosci", "newsroom"];

/** The currently-installable package for `id`. */
function current(id: string) {
  return getBuiltinTemplate(id)!;
}

/** The retained `0.1.0` release for `id`. */
function published010(id: string) {
  return getBuiltinTemplateRelease(id, "0.1.0", "atomicstrata");
}

/** The same entity block with every `titleField` removed, for comparison. */
function stripTitles(entities: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(entities).map(([type, def]) => {
      const { titleField: _dropped, ...rest } = def;
      return [type, rest];
    }),
  );
}

describe.each(TEMPLATE_IDS)("%s 0.2.0 titles every type by a field it declares", (id) => {
  it("declares a titleField on every entity type", () => {
    for (const [type, def] of Object.entries(current(id).profile.entities)) {
      expect(def.titleField, `${id}/${type}`).toBeDefined();
    }
  });

  it("names a declared field of that type, never an undeclared one", () => {
    for (const [type, def] of Object.entries(current(id).profile.entities)) {
      expect(Object.keys(def.fields ?? {}), `${id}/${type}`).toContain(def.titleField);
    }
  });

  it("names the field the type actually carries its display name in", () => {
    for (const [type, field] of Object.entries(EXPECTED_TITLE_FIELDS[id])) {
      expect(current(id).profile.entities[type]?.titleField, `${id}/${type}`).toBe(field);
    }
  });

  it("advances both the package and profile version", () => {
    expect(current(id).version).toBe("0.2.0");
    expect(current(id).profile.profileVersion).toBe("0.2.0");
  });

  it("installs 0.2.0 as the latest, listing it exactly once", () => {
    const listed = listBuiltinTemplates().filter((template) => template.templateId === id);
    expect(listed).toHaveLength(1);
    expect(listed[0].version).toBe("0.2.0");
  });
});

describe.each(TEMPLATE_IDS)("%s 0.1.0 stays exactly resolvable", (id) => {
  it("resolves by its complete published identity", () => {
    expect(published010(id)).toBeDefined();
    expect(published010(id)?.profile.profileVersion).toBe("0.1.0");
  });

  it("digests to what 0.1.0 actually published", () => {
    expect(profileDigest(published010(id)!.profile)).toBe(PUBLISHED_0_1_0_DIGESTS[id]);
  });

  it("carries no titleField, so a 0.1.0 install is not read as modified", () => {
    for (const [type, def] of Object.entries(published010(id)!.profile.entities)) {
      expect(def, `${id}/${type}`).not.toHaveProperty("titleField");
    }
  });

  it("differs from 0.2.0 by nothing but the title declarations", () => {
    expect(stripTitles(published010(id)!.profile.entities as never)).toEqual(
      stripTitles(current(id).profile.entities as never),
    );
  });

  it("is still recognised as shipped bytes, not a locally modified profile", () => {
    expect(isShippedBuiltinProfile(published010(id)!.profile)).toBe(true);
    expect(isShippedBuiltinProfile(current(id).profile)).toBe(true);
  });
});
