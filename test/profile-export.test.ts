/**
 * @file test/profile-export.test.ts
 * @description Tests for the additive `profile` entity block on JSON export.
 *
 * Covers: (a) a DEFAULT project's `exportJson` document has NO `profile` key and
 * its legacy `pages` reflects only concepts/queries; (b) a NON-default project
 * surfaces `profile.entityPages` (the content-bearing EntityPage shape) with
 * `profileId`, leaving the legacy `pages` array scoped to concepts/queries; and
 * surfaces collector `problems` for a contract violation.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportJson } from "../src/commands/export.js";
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
  root = await mkdtemp(path.join(os.tmpdir(), "profile-export-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("exportJson — default profile", () => {
  it("has no profile key and exports concepts legacily", async () => {
    await writePage(CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody.");
    const doc = await exportJson(root);
    expect("profile" in doc).toBe(false);
    expect(doc.pages.map((p) => p.slug)).toEqual(["alpha"]);
  });
});

describe("exportJson — non-default profile", () => {
  beforeEach(async () => {
    await writeProfile(PROFILE);
    await writePage("wiki/notes", "first-note", "---\ntitle: First\n---\nNote body.");
  });

  it("adds a profile block with content-bearing entity pages", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.profileId).toBe("sample");
    expect(doc.profile?.entityPages).toHaveLength(1);
    const page = doc.profile!.entityPages[0];
    expect(page.entityType).toBe("notes");
    expect(page.slug).toBe("first-note");
    expect(page.body).toBe("Note body.");
  });

  it("leaves the legacy pages array scoped to concepts/queries", async () => {
    const doc = await exportJson(root);
    expect(doc.pages).toHaveLength(0);
  });

  it("surfaces collector problems for a contract violation", async () => {
    await writePage("wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title.");
    const doc = await exportJson(root);
    expect(doc.profile?.problems?.some((m) => m.includes("title"))).toBe(true);
  });
});
