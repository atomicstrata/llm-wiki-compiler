/**
 * @file test/profile-extract-validate.test.ts
 * @description Loading a profile type that opts into extraction: its directory
 * must be `wiki/<type>`, its `extract.fields` must name declared fields, and it
 * cannot declare the keys every extracted record answers (`name`, `writtenAs`,
 * `lines`).
 */

import { describe, expect, it } from "bun:test";
import { validateProfile } from "../src/profile/validate.js";

/** A profile whose `person` type opts into extraction with `fields`. */
function personPack(fields: Record<string, unknown>, directory = "wiki/person"): unknown {
  return {
    schemaVersion: 1, profileId: "people", displayName: "People",
    entities: { person: { directory, fields: { title: { type: "string" }, ...fields }, extract: { description: "A person" } } },
  };
}

describe("a profile type with extract", () => {
  it("loads with ordinary fields", () => {
    expect(() => validateProfile(personPack({ role: { type: "string" } }))).not.toThrow();
  });

  it.each(["name", "writtenAs", "lines"])("cannot declare the record key %s", (key) => {
    expect(() => validateProfile(personPack({ [key]: { type: "string" } }))).toThrow(`cannot declare field '${key}'`);
  });

  it("must live in wiki/<type>", () => {
    expect(() => validateProfile(personPack({}, "wiki/people"))).toThrow("must use directory 'wiki/person'");
  });
});
