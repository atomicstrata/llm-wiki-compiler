/**
 * @file test/profile-listpages.test.ts
 * @description Tests for the additive `profile` entity block on `listPages`.
 *
 * Covers: (a) a DEFAULT project's result has NO `profile` key and the legacy
 * `pages` block reflects only concepts/queries; (b) a NON-default project
 * surfaces `profile.entityPages` with content, honors `includeBody` (body
 * present when true, empty when false), and surfaces collector `problems`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listPages } from "../src/pages/list.js";
import { CONCEPTS_DIR, PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/** A non-default profile: `notes` requires a `title`, lives at wiki/notes. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "sample",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { title: { type: "string" } },
    },
  },
};

/** Write the profile.json into the project's .llmwiki/ dir. */
async function writeProfile(pack: ProfilePack): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack));
}

/** Write a markdown page with the given relative dir, slug, and content. */
async function writePage(dir: string, slug: string, content: string): Promise<void> {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, dir, `${slug}.md`), content);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-listpages-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("listPages — default profile", () => {
  it("has no profile block and lists concept pages legacily", async () => {
    await writePage(CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody alpha.");
    const result = await listPages(root, { includeBody: true });
    expect(result.profile).toBeUndefined();
    expect(result.pages.map((p) => p.slug)).toEqual(["alpha"]);
    expect(result.pages[0].body).toBe("Body alpha.");
  });
});

describe("listPages — non-default profile", () => {
  beforeEach(async () => {
    await writeProfile(PROFILE);
    await writePage("wiki/notes", "first-note", "---\ntitle: First\n---\nNote body.");
  });

  it("surfaces entity pages with body when includeBody is true", async () => {
    const result = await listPages(root, { includeBody: true });
    expect(result.pages).toHaveLength(0);
    expect(result.profile?.entityPages).toHaveLength(1);
    const page = result.profile!.entityPages[0];
    expect(page.entityType).toBe("notes");
    expect(page.slug).toBe("first-note");
    expect(page.body).toBe("Note body.");
  });

  it("strips entity-page body when includeBody is false", async () => {
    const result = await listPages(root, { includeBody: false });
    expect(result.profile?.entityPages[0].body).toBe("");
  });

  it("surfaces collector problems for a contract violation", async () => {
    await writePage("wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title here.");
    const result = await listPages(root, {});
    expect(result.profile?.problems?.length).toBeGreaterThan(0);
    expect(result.profile!.problems!.some((m) => m.includes("title"))).toBe(true);
  });
});
