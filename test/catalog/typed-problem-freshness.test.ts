/**
 * @file test/catalog/typed-problem-freshness.test.ts
 * @description A problem cursor must serve current problems for a changed entity file,
 * even when the independent page cursor does not visit that entity.
 */

import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { routedListPages } from "../../src/catalog/routes.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { setIndexedScale } from "./cli-helpers.js";

it("reprojects a changed problem row outside the page window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-problem-freshness-"));
  try {
    await writeProfileFile(root, SAMPLE_PROFILE);
    await writeMarkdownPage(root, "wiki/notes", "alpha", "---\ntitle: Alpha\n---\nA.");
    await writeMarkdownPage(root, "wiki/notes", "m-no-title", "---\nslug: m-no-title\n---\nM.");
    await writeMarkdownPage(root, "wiki/notes", "zz-no-title", "---\nslug: zz-no-title\n---\nZ.");
    const entityDir = path.join(root, "wiki/notes");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(entityDir, old, old);
    await setIndexedScale(root);
    const first = await routedListPages(root, { limit: 1 });
    expect(first.catalog?.state).toBe("fresh");
    expect(first.profile?.problems?.map((problem) => problem.kind)).toEqual(["field-violation"]);
    const cursor = first.profile?.problemCursor;
    expect(cursor).toBeDefined();
    const beforeDir = await stat(entityDir);
    await writeMarkdownPage(root, "wiki/notes", "zz-no-title", "---\ntitle: Fixed\nslug: zz-no-title\n---\nZ.");
    await utimes(path.join(entityDir, "zz-no-title.md"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    expect((await stat(entityDir)).mtimeMs).toBe(beforeDir.mtimeMs);
    const later = await routedListPages(root, { limit: 1, problemCursor: cursor });
    expect(later.profile?.entityPages.map((page) => page.slug)).toEqual(["alpha"]);
    expect(later.profile?.problems).toEqual([]);
    expect(later.catalog?.state).toBe("stale");
    expect(later.catalog?.staleRows?.sample).toContain("wiki/notes/zz-no-title.md");
    expect(later.profile?.problemTotal).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("shows a newly introduced problem while keeping the catalogued zero total", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-new-problem-"));
  try {
    await writeProfileFile(root, SAMPLE_PROFILE);
    await writeMarkdownPage(root, "wiki/notes", "alpha", "---\ntitle: Alpha\n---\nA.");
    await writeMarkdownPage(root, "wiki/notes", "zz-valid", "---\ntitle: Valid\n---\nZ.");
    const entityDir = path.join(root, "wiki/notes");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(entityDir, old, old);
    await setIndexedScale(root);
    const beforeDir = await stat(entityDir);
    await writeMarkdownPage(root, "wiki/notes", "zz-valid", "---\nslug: zz-valid\n---\nZ.");
    await utimes(path.join(entityDir, "zz-valid.md"), new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    expect((await stat(entityDir)).mtimeMs).toBe(beforeDir.mtimeMs);
    const listed = await routedListPages(root, { limit: 1 });
    expect(listed.profile?.entityPages.map((page) => page.slug)).toEqual(["alpha"]);
    expect(listed.profile?.problems?.map((problem) => problem.kind)).toEqual(["field-violation"]);
    expect(listed.profile?.problemTotal).toBe(0);
    expect(listed.catalog?.state).toBe("stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
