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
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportJson } from "../src/commands/export.js";
import { createWiki } from "../src/index.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  writeMarkdownPage,
  seedSampleNotesProject,
  expectFirstNotePage,
} from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-export-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("exportJson — default profile", () => {
  it("has no profile key and exports concepts legacily", async () => {
    await writeMarkdownPage(root, CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody.");
    const doc = await exportJson(root);
    expect("profile" in doc).toBe(false);
    expect(doc.pages.map((p) => p.slug)).toEqual(["alpha"]);
  });
});

describe("exportJson — non-default profile", () => {
  beforeEach(async () => {
    await seedSampleNotesProject(root);
  });

  it("adds a profile block with content-bearing entity pages", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.profileId).toBe("sample");
    expect(doc.profile?.entityPages).toHaveLength(1);
    expectFirstNotePage(doc.profile!.entityPages[0]);
  });

  it("stamps the experimental block version (distinct from schemaVersion)", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.version).toBe(1);
    expect(doc.schemaVersion).toBe(1);
  });

  it("leaves the legacy pages array scoped to concepts/queries", async () => {
    const doc = await exportJson(root);
    expect(doc.pages).toHaveLength(0);
  });

  it("surfaces collector problems for a contract violation", async () => {
    await writeMarkdownPage(root, "wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title.");
    const doc = await exportJson(root);
    expect(doc.profile?.problems?.some((m) => m.includes("title"))).toBe(true);
  });

  it("never leaks an absolute filePath in the profile block", async () => {
    const doc = await exportJson(root);
    const json = JSON.stringify(doc.profile);
    expect(json).not.toContain("filePath");
    expect(json).not.toContain(root);
  });
});

describe("exportJson — forge-proof public options", () => {
  it("ignores a forged profile block on a default project", async () => {
    await writeMarkdownPage(root, CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody.");
    const wiki = createWiki({ root });
    const doc = await wiki.exportJson({ profile: { profileId: "forged" } } as never);
    expect("profile" in doc).toBe(false);
  });
});
