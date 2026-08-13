/**
 * @file test/profile-template-autosci-releases.test.ts
 * @description The AutoSci release line: `0.2.0` declares a `titleField` per
 * entity type, and the superseded `0.1.0` stays resolvable.
 *
 * Retention is load-bearing rather than ceremonial. `planTemplateUpdate`
 * resolves the INSTALLED release and compares its `profileDigest` against the
 * on-disk profile to decide whether a project carries local modifications — so a
 * dropped `0.1.0` makes `planBuiltinTemplateUpdate` throw for every project
 * still on it, and a `0.1.0` that silently gained `titleField` would report every
 * genuine `0.1.0` install as modified.
 *
 * `0.1.0`'s entity block is DERIVED from `0.2.0` by dropping the title
 * declarations, which are the only difference between the releases. The digest
 * pinned below is the one `0.1.0` actually published, computed from the pre-change
 * source — so it is an independent check on the derivation, not a restatement of
 * it. A later edit to the `0.2.0` entities that leaks into the derived `0.1.0`
 * fails here rather than quietly mis-describing an installed project.
 */

import { describe, expect, it } from "vitest";
import {
  getBuiltinTemplate,
  getBuiltinTemplateRelease,
  isShippedBuiltinProfile,
  listBuiltinTemplates,
} from "../src/profile/templates/registry.js";
import { profileDigest } from "../src/profile/digest.js";

/** The `profileDigest` of the AutoSci pack exactly as `0.1.0` published it. */
const PUBLISHED_0_1_0_DIGEST =
  "bf48a4e77f9f40e06d8c56514851e678c59dfa217e4542f38d0fc8ef5e9e5489";

/** The currently-installable AutoSci package. */
function current() {
  return getBuiltinTemplate("autosci")!;
}

/** The retained `0.1.0` release. */
function published010() {
  return getBuiltinTemplateRelease("autosci", "0.1.0", "atomicstrata");
}

describe("AutoSci 0.2.0 titles every type by a field that type declares", () => {
  it("declares a titleField on every entity type", () => {
    for (const [type, def] of Object.entries(current().profile.entities)) {
      expect(def.titleField, type).toBeDefined();
    }
  });

  it("names a declared field of each type, never an undeclared one", () => {
    for (const [type, def] of Object.entries(current().profile.entities)) {
      expect(Object.keys(def.fields ?? {}), type).toContain(def.titleField);
    }
  });

  // The type this whole change exists for: `people` carries `name`, not `title`,
  // so every surface showed its slug.
  it("titles people by name rather than by the literal title key", () => {
    expect(current().profile.entities.people.titleField).toBe("name");
  });

  it("advances both the package and profile version", () => {
    expect(current().version).toBe("0.2.0");
    expect(current().profile.profileVersion).toBe("0.2.0");
  });

  it("installs 0.2.0 as the latest, listing it once", () => {
    const listed = listBuiltinTemplates().filter((t) => t.templateId === "autosci");
    expect(listed).toHaveLength(1);
    expect(listed[0].version).toBe("0.2.0");
  });
});

describe("the superseded 0.1.0 release stays exactly resolvable", () => {
  it("resolves by its complete published identity", () => {
    expect(published010()).toBeDefined();
    expect(published010()?.profile.profileVersion).toBe("0.1.0");
  });

  it("digests to what 0.1.0 actually published", () => {
    expect(profileDigest(published010()!.profile)).toBe(PUBLISHED_0_1_0_DIGEST);
  });

  it("carries no titleField, so a 0.1.0 install is not read as modified", () => {
    for (const [type, def] of Object.entries(published010()!.profile.entities)) {
      expect(def, type).not.toHaveProperty("titleField");
    }
  });

  it("differs from 0.2.0 by nothing but the title declarations", () => {
    const strip = (entities: Record<string, Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(entities).map(([type, def]) => {
          const { titleField: _dropped, ...rest } = def;
          return [type, rest];
        }),
      );
    expect(strip(published010()!.profile.entities as never)).toEqual(
      strip(current().profile.entities as never),
    );
  });

  it("is still recognised as shipped bytes, not a locally modified profile", () => {
    expect(isShippedBuiltinProfile(published010()!.profile)).toBe(true);
    expect(isShippedBuiltinProfile(current().profile)).toBe(true);
  });
});
