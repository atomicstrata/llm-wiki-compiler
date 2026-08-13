/**
 * @file test/profile-template-releases.test.ts
 * @description The shipped non-default templates' release lines, and the
 * retention that keeps every superseded release resolvable.
 *
 * Both templates gained a `titleField` per entity type at `0.2.0`; AutoSci then
 * gained `doi`/`arxiv`/`url` field formats at `0.3.0`.
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

/**
 * Every superseded release's published `profileDigest`, each computed from the
 * source AS IT WAS at that version rather than from the derivation under test.
 */
const PUBLISHED_DIGESTS: Record<string, Record<string, string>> = {
  autosci: {
    "0.1.0": "bf48a4e77f9f40e06d8c56514851e678c59dfa217e4542f38d0fc8ef5e9e5489",
    "0.2.0": "7492d386a0fb8df534849981c40ebbe1a578aadc9bff30898c989bb164731798",
  },
  newsroom: { "0.1.0": "866882812c21c769e469d3f842b5bbdcc1d14cab4195cdb701d4c4181e4000ae" },
};

/** The version each template currently ships. */
const CURRENT_VERSIONS: Record<string, string> = { autosci: "0.3.0", newsroom: "0.2.0" };

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

/** A retained release of `id` by version. */
function retained(id: string, version: string) {
  return getBuiltinTemplateRelease(id, version, "atomicstrata");
}

/** The retained `0.1.0` release for `id` — the pre-`titleField` one. */
function published010(id: string) {
  return retained(id, "0.1.0");
}

/**
 * The same entity block with every declaration the release line ADDED removed —
 * `titleField` per type and `format` per field.
 *
 * Comparing the stripped forms states the thing the digest pins cannot: that
 * apart from those declarations, no other drift crept into a retained release.
 * It is deliberately not a re-application of the derivation under test, which
 * would be circular.
 */
function stripAdded(entities: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(entities).map(([type, def]) => {
      const { titleField: _title, fields, ...rest } = def;
      return [type, { ...rest, fields: stripFormats(fields as Record<string, Record<string, unknown>>) }];
    }),
  );
}

/** A field map with every `format` removed; `undefined` stays `undefined`. */
function stripFormats(fields: Record<string, Record<string, unknown>> | undefined) {
  if (fields === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const { format: _dropped, ...rest } = field;
      return [name, rest];
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

  it("keeps the package and profile version in step", () => {
    expect(current(id).version).toBe(CURRENT_VERSIONS[id]);
    expect(current(id).profile.profileVersion).toBe(CURRENT_VERSIONS[id]);
  });

  it("installs the newest release, listing it exactly once", () => {
    const listed = listBuiltinTemplates().filter((template) => template.templateId === id);
    expect(listed).toHaveLength(1);
    expect(listed[0].version).toBe(CURRENT_VERSIONS[id]);
  });
});

describe.each(TEMPLATE_IDS)("%s 0.1.0 stays exactly resolvable", (id) => {
  it("resolves by its complete published identity", () => {
    expect(published010(id)).toBeDefined();
    expect(published010(id)?.profile.profileVersion).toBe("0.1.0");
  });

  it("digests every retained release to what that release actually published", () => {
    for (const [version, digest] of Object.entries(PUBLISHED_DIGESTS[id])) {
      const release = retained(id, version);
      expect(release, `${id}@${version}`).toBeDefined();
      expect(profileDigest(release!.profile), `${id}@${version}`).toBe(digest);
    }
  });

  it("carries no titleField, so a 0.1.0 install is not read as modified", () => {
    for (const [type, def] of Object.entries(published010(id)!.profile.entities)) {
      expect(def, `${id}/${type}`).not.toHaveProperty("titleField");
    }
  });

  it("differs from the current release by nothing but those declarations", () => {
    for (const version of Object.keys(PUBLISHED_DIGESTS[id])) {
      expect(stripAdded(retained(id, version)!.profile.entities as never), version).toEqual(
        stripAdded(current(id).profile.entities as never),
      );
    }
  });

  it("recognises every retained release as shipped bytes, not a modified profile", () => {
    for (const version of Object.keys(PUBLISHED_DIGESTS[id])) {
      expect(isShippedBuiltinProfile(retained(id, version)!.profile), version).toBe(true);
    }
    expect(isShippedBuiltinProfile(current(id).profile)).toBe(true);
  });
});
