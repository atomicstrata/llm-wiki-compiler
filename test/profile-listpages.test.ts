/**
 * @file test/profile-listpages.test.ts
 * @description Tests for the additive `profile` entity block on `listPages`.
 *
 * Covers: (a) a DEFAULT project's result has NO `profile` key and the legacy
 * `pages` block reflects only concepts/queries; (b) a NON-default project
 * surfaces `profile.entityPages` with content as the public `EntityPageView`
 * (project-relative `path`, never an absolute `filePath`), honors `includeBody`
 * (body present when true, OMITTED when false), and surfaces collector
 * `problems`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listPages } from "../src/pages/list.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  writeMarkdownPage,
  seedSampleNotesProject,
  expectFirstNotePage,
} from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-listpages-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("listPages — default profile", () => {
  it("has no profile block and lists concept pages legacily", async () => {
    await writeMarkdownPage(root, CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody alpha.");
    const result = await listPages(root, { includeBody: true });
    expect(result.profile).toBeUndefined();
    expect(result.pages.map((p) => p.slug)).toEqual(["alpha"]);
    expect(result.pages[0].body).toBe("Body alpha.");
  });
});

describe("listPages — non-default profile", () => {
  beforeEach(async () => {
    await seedSampleNotesProject(root);
  });

  it("surfaces entity pages with body when includeBody is true", async () => {
    const result = await listPages(root, { includeBody: true });
    expect(result.pages).toHaveLength(0);
    expect(result.profile?.entityPages).toHaveLength(1);
    expectFirstNotePage(result.profile!.entityPages[0]);
  });

  it("OMITS entity-page body when includeBody is false", async () => {
    const result = await listPages(root, { includeBody: false });
    const page = result.profile!.entityPages[0];
    expect("body" in page).toBe(false);
  });

  it("never leaks an absolute filePath in entity pages", async () => {
    const result = await listPages(root, { includeBody: true });
    const json = JSON.stringify(result.profile!.entityPages);
    expect(json).not.toContain("filePath");
    expect(json).not.toContain(root);
  });

  it("surfaces collector problems for a contract violation", async () => {
    await writeMarkdownPage(root, "wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title here.");
    const result = await listPages(root, {});
    expect(result.profile?.problems?.length).toBeGreaterThan(0);
    expect(result.profile!.problems!.some((p) => p.message.includes("title"))).toBe(true);
  });
});
