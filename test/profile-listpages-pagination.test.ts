/**
 * @file test/profile-listpages-pagination.test.ts
 * @description Tests for the BOUNDED, independently-paginated entity section of
 * the additive `profile` block on `listPages` (audit fix M1).
 *
 * Covers: a non-default project with more entity pages than `limit` returns at
 * most `limit` `entityPages`, the full `profile.total`, and an opaque
 * `profile.cursor`; passing that cursor as `profileCursor` returns the next
 * batch; the final batch carries no `cursor`; the window is sorted by `id`
 * (stable across calls); `includeBody` is still honored; and a DEFAULT project
 * still has no `profile` block at all.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listPages } from "../src/pages/list.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  writeMarkdownPage,
  seedManyNotesProject,
  seedBrokenNotesProject,
} from "./fixtures/profile-fixtures.js";

let root = "";
const TOTAL_NOTES = 5;
const PAGE_LIMIT = 2;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-listpages-pg-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("listPages entity section — default profile", () => {
  it("has no profile block regardless of limit", async () => {
    await writeMarkdownPage(root, CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody.");
    const result = await listPages(root, { limit: PAGE_LIMIT });
    expect(result.profile).toBeUndefined();
  });
});

describe("listPages entity section — bounded + paginated", () => {
  beforeEach(async () => {
    await seedManyNotesProject(root, TOTAL_NOTES);
  });

  it("returns at most `limit` entity pages with total and a cursor", async () => {
    const result = await listPages(root, { limit: PAGE_LIMIT });
    expect(result.profile?.entityPages).toHaveLength(PAGE_LIMIT);
    expect(result.profile?.total).toBe(TOTAL_NOTES);
    expect(result.profile?.cursor).toBeDefined();
  });

  it("walks every page via profileCursor, sorted by id, last batch has no cursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listPages(root, { limit: PAGE_LIMIT, profileCursor: cursor });
      expect(result.profile!.entityPages.length).toBeLessThanOrEqual(PAGE_LIMIT);
      for (const p of result.profile!.entityPages) seen.push(p.id);
      cursor = result.profile!.cursor;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(TOTAL_NOTES);
    expect(seen).toEqual([...seen].sort());
  });

  it("honors includeBody on the windowed entity pages", async () => {
    const withBody = await listPages(root, { limit: PAGE_LIMIT, includeBody: true });
    const withoutBody = await listPages(root, { limit: PAGE_LIMIT, includeBody: false });
    expect(typeof withBody.profile!.entityPages[0].body).toBe("string");
    expect("body" in withoutBody.profile!.entityPages[0]).toBe(false);
  });

  it("is not re-sliced by the legacy pages cursor", async () => {
    const first = await listPages(root, { limit: PAGE_LIMIT });
    const firstIds = first.profile!.entityPages.map((p) => p.id);
    // A legacy `cursor` paginates `pages` only; the entity window must be stable.
    const withLegacyCursor = await listPages(root, { limit: PAGE_LIMIT, cursor: "0" });
    expect(withLegacyCursor.profile!.entityPages.map((p) => p.id)).toEqual(firstIds);
  });
});

describe("listPages problems — bounded by limit with own problemCursor", () => {
  beforeEach(async () => {
    await seedBrokenNotesProject(root, TOTAL_NOTES);
  });

  it("returns at most `limit` problems with the full problemTotal and a problemCursor", async () => {
    const result = await listPages(root, { limit: PAGE_LIMIT });
    expect(result.profile!.problems!.length).toBeLessThanOrEqual(PAGE_LIMIT);
    expect(result.profile!.problemTotal).toBe(TOTAL_NOTES);
    expect(result.profile!.problemCursor).toBeDefined();
  });

  it("walks every problem via problemCursor, last batch has no problemCursor", async () => {
    let seen = 0;
    let problemCursor: string | undefined;
    do {
      const result = await listPages(root, { limit: PAGE_LIMIT, problemCursor });
      seen += result.profile!.problems!.length;
      problemCursor = result.profile!.problemCursor;
    } while (problemCursor !== undefined);
    expect(seen).toBe(TOTAL_NOTES);
  });

  it("paginates problems independently of the entity-page window", async () => {
    const result = await listPages(root, { limit: PAGE_LIMIT, profileCursor: "4" });
    // entity window is exhausted (offset 4 of 5) but problems restart at offset 0.
    expect(result.profile!.entityPages).toHaveLength(1);
    expect(result.profile!.problems!.length).toBe(PAGE_LIMIT);
    expect(result.profile!.problemTotal).toBe(TOTAL_NOTES);
  });
});
