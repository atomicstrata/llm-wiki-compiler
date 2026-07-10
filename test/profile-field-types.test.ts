/**
 * @file test/profile-field-types.test.ts
 * @description Tests for full field-TYPE and min/max contract validation in the
 * non-default collector (`collectEntityPages`), plus the count-only summary path
 * (`collectEntitySummary`) that produces counts + problems WITHOUT retaining
 * page bodies.
 *
 * Covers (M3): a present value mismatching its declared `integer`/`string[]`/
 * `date` type, and a numeric value outside its declared `[min, max]`, each yield
 * a PATH-FREE `field-violation` problem while the page is STILL produced.
 * Covers (M2): `collectEntitySummary` returns per-type counts + identical
 * problems with no body-bearing page objects.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  collectEntityPages,
  collectEntitySummary,
  EntityCollectError,
} from "../src/profile/collect.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/** A profile whose `notes` type declares typed + bounded fields. */
const TYPED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "typed",
  entities: {
    notes: {
      directory: "wiki/notes",
      fields: {
        year: { type: "integer" },
        importance: { type: "integer", min: 1, max: 5 },
        tags: { type: "string[]" },
        due: { type: "date" },
      },
    },
  },
};

/** Write a `wiki/notes/<stem>.md` page with the given raw frontmatter body. */
async function writeNote(stem: string, frontmatter: string): Promise<void> {
  const notesDir = path.join(root, "wiki/notes");
  await mkdir(notesDir, { recursive: true });
  await writeFile(path.join(notesDir, `${stem}.md`), `---\n${frontmatter}\n---\n# ${stem}\n`);
}

/** Collect TYPED_PROFILE and return only the `notes` field-violation messages. */
async function violationMessages(): Promise<string[]> {
  const { problems } = await collectEntityPages(root, TYPED_PROFILE);
  return problems.filter((p) => p.kind === "field-violation").map((p) => p.message);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-field-types-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("checkFieldContract — declared TYPE enforced as field-violation", () => {
  it("flags a non-integer integer field, still producing the page", async () => {
    await writeNote("bad-year", 'year: "twenty"');
    const { pages } = await collectEntityPages(root, TYPED_PROFILE);
    expect(pages.map((p) => p.id)).toEqual(["notes/bad-year"]);
    const messages = await violationMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"year".*not a valid integer/);
  });

  it("flags a string[] field whose value is a bare string", async () => {
    await writeNote("bad-tags", 'tags: "x"');
    const messages = await violationMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"tags".*not a valid string\[\]/);
  });

  it("flags a date field whose value does not parse as a date", async () => {
    await writeNote("bad-date", 'due: "not-a-date"');
    const messages = await violationMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"due".*not a valid date/);
  });
});

describe("checkFieldContract — min/max enforced as field-violation", () => {
  it("flags a numeric value above the declared max", async () => {
    await writeNote("too-big", "importance: 99");
    const messages = await violationMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"importance" value 99 exceeds max 5/);
  });

  it("flags a numeric value below the declared min", async () => {
    await writeNote("too-small", "importance: 0");
    const messages = await violationMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/"importance" value 0 is below min 1/);
  });

  it("accepts an in-range, correctly-typed page with no problems", async () => {
    await writeNote("good", "year: 2026\nimportance: 3\ntags:\n  - a\ndue: 2026-01-01");
    const { pages, problems } = await collectEntityPages(root, TYPED_PROFILE);
    expect(pages.map((p) => p.id)).toEqual(["notes/good"]);
    expect(problems).toEqual([]);
  });
});

describe("field-violation messages are PATH-FREE", () => {
  it("never embeds the absolute filePath in the message text", async () => {
    await writeNote("bad-year", 'year: "twenty"');
    const { problems } = await collectEntityPages(root, TYPED_PROFILE);
    const violation = problems.find((p) => p.kind === "field-violation");
    expect(violation?.filePath).toContain(root);
    expect(violation?.message).not.toContain(root);
    expect(violation?.message).not.toContain("/");
  });
});

/** A profile whose `notes` type marks `title` required via per-field `required`. */
const PER_FIELD_REQUIRED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "per-field-required",
  entities: {
    notes: { directory: "wiki/notes", fields: { title: { type: "string", required: true } } },
  },
};

/** A profile that declares `title` required BOTH via array AND per-field flag. */
const DOUBLY_REQUIRED_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "doubly-required",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { title: { type: "string", required: true } },
    },
  },
};

/** Collect `profile` and return only the `field-violation` problem messages. */
async function violationsFor(profile: ProfilePack): Promise<string[]> {
  const { problems } = await collectEntityPages(root, profile);
  return problems.filter((p) => p.kind === "field-violation").map((p) => p.message);
}

describe("checkFieldContract — per-field required: true enforced", () => {
  it("flags a missing field declared required via per-field flag exactly once", async () => {
    await writeNote("no-title", "year: 2026");
    const messages = await violationsFor(PER_FIELD_REQUIRED_PROFILE);
    expect(messages).toEqual([expect.stringMatching(/Required field "title" is missing/)]);
  });

  it("does not flag a present per-field-required field", async () => {
    await writeNote("has-title", 'title: "Hello"');
    expect(await violationsFor(PER_FIELD_REQUIRED_PROFILE)).toEqual([]);
  });

  it("yields ONE problem when a field is required both via array and per-field", async () => {
    await writeNote("no-title", "year: 2026");
    const messages = await violationsFor(DOUBLY_REQUIRED_PROFILE);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Required field "title" is missing/);
  });
});

/** A profile whose `notes` type declares an `owner` field of type `slug`. */
const SLUG_FIELD_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "slug-field",
  entities: { notes: { directory: "wiki/notes", fields: { owner: { type: "slug" } } } },
};

describe("checkFieldContract — slug type validates slug-safety", () => {
  it("accepts a slug-safe owner value with no problems", async () => {
    await writeNote("ok", 'owner: "ok-slug"');
    expect(await violationsFor(SLUG_FIELD_PROFILE)).toEqual([]);
  });

  it.each([["Bad Slug!"], ["UPPER"], [" leading"]])(
    "flags a non-slug-safe owner value %j as a field-violation",
    async (value) => {
      await writeNote("bad", `owner: ${JSON.stringify(value)}`);
      const messages = await violationsFor(SLUG_FIELD_PROFILE);
      expect(messages).toEqual([expect.stringMatching(/"owner".*not a valid slug/)]);
    },
  );
});

describe("collectEntitySummary — count-only, no bodies retained", () => {
  it("rejects the default profile (programming-error guard)", async () => {
    await expect(collectEntitySummary(root, DEFAULT_PROFILE)).rejects.toBeInstanceOf(EntityCollectError);
  });

  it("returns per-type counts + problems and no page/body objects", async () => {
    await writeNote("a", "year: 2026");
    await writeNote("b", 'year: "twenty"');
    const summary = await collectEntitySummary(root, TYPED_PROFILE);
    // note "a" is valid (year: 2026 parses as integer); note "b" has a
    // field-violation so it is excluded from the count but surfaced as a problem.
    expect(summary.counts).toEqual({ notes: 1 });
    expect(summary.problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/"year".*not a valid integer/),
    ]);
    expect("pages" in summary).toBe(false);
    expect(Object.values(summary).some((v) => Array.isArray(v) && v.some((x: unknown) => typeof x === "object" && x !== null && "body" in (x as object)))).toBe(false);
  });

  it("produces problems IDENTICAL to the content collector, excluding invalid pages from the count", async () => {
    await writeNote("a", "importance: 99");
    await writeNote("b", "importance: 3");
    const summary = await collectEntitySummary(root, TYPED_PROFILE);
    const full = await collectEntityPages(root, TYPED_PROFILE);
    // note "a" violates max:5 → excluded from summary count, surfaced as problem
    // note "b" is valid → counted; full collector still produces both pages
    expect(summary.counts).toEqual({ notes: 1 });
    expect(summary.problems).toEqual(full.problems);
  });
});
