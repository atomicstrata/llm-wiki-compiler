/**
 * @file test/profile-collect.test.ts
 * @description Tests for the shared raw scanner (`collectRawWikiPages`) and the
 * non-default-only typed collector (`collectEntityPages`).
 *
 * Covers: (a) the default profile is REJECTED by `collectEntityPages`;
 * (b) `collectRawWikiPages` preserves non-slug-safe stems (`Foo Bar`, `研究`)
 * VERBATIM as slug values; (c) a small non-default profile yields strict
 * branded `EntityPageRef`s; (d) a non-slug-safe stem under a non-default entity
 * dir fails closed with a rename hint (never silently slugified or skipped).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectRawWikiPages } from "../src/wiki/collect.js";
import { collectEntityPages, EntityCollectError } from "../src/profile/collect.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import type { ProfilePack } from "../src/profile/types.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";

let root = "";

/** A small non-default profile declaring two entity types under wiki/. */
const SAMPLE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "sample",
  entities: {
    notes: { directory: "wiki/notes" },
    tasks: { directory: "wiki/tasks" },
  },
};

/** Write a minimal markdown page (optional frontmatter slug) at a raw stem. */
async function writePage(dir: string, stem: string, frontmatterSlug?: string): Promise<void> {
  const fm = frontmatterSlug !== undefined ? `---\nslug: ${frontmatterSlug}\n---\n\n` : "";
  await writeFile(path.join(dir, `${stem}.md`), `${fm}# ${stem}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-collect-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("collectEntityPages — non-default only", () => {
  it("throws when handed the default profile", async () => {
    await expect(collectEntityPages(root, DEFAULT_PROFILE)).rejects.toBeInstanceOf(EntityCollectError);
  });
});

describe("collectRawWikiPages — verbatim raw stems", () => {
  it("preserves non-slug-safe stems (space, CJK) as slug byte-for-byte", async () => {
    const concepts = path.join(root, CONCEPTS_DIR);
    await mkdir(path.join(root, QUERIES_DIR), { recursive: true });
    await mkdir(concepts, { recursive: true });
    await writePage(concepts, "Foo Bar");
    await writePage(concepts, "研究");
    await writePage(concepts, "plain");
    const pages = await collectRawWikiPages(root);
    const slugs = pages.map((p) => p.slug).sort();
    expect(slugs).toEqual(["Foo Bar", "plain", "研究"].sort());
    expect(pages.every((p) => p.pageDirectory === "concepts")).toBe(true);
  });
});

describe("collectEntityPages — strict EntityPageRefs", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await mkdir(path.join(root, "wiki/tasks"), { recursive: true });
  });

  it("mints branded ids for slug-safe stems across entity types", async () => {
    await writePage(path.join(root, "wiki/notes"), "first-note", "first-note");
    await writePage(path.join(root, "wiki/tasks"), "do-thing");
    const refs = await collectEntityPages(root, SAMPLE_PROFILE);
    const byId = Object.fromEntries(refs.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(["notes/first-note", "tasks/do-thing"]);
    expect(byId["notes/first-note"]).toMatchObject({ entityType: "notes", slug: "first-note", directory: "wiki/notes" });
  });

  it("fails closed on a frontmatter slug that disagrees with the stem", async () => {
    await writePage(path.join(root, "wiki/notes"), "first-note", "other-slug");
    await expect(collectEntityPages(root, SAMPLE_PROFILE)).rejects.toThrow(/does not match file stem/);
  });
});

describe("collectEntityPages — fail closed on non-slug-safe stems", () => {
  it("rejects a non-slug-safe filename with a rename hint, never slugifying", async () => {
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await mkdir(path.join(root, "wiki/tasks"), { recursive: true });
    await writePage(path.join(root, "wiki/notes"), "Foo Bar");
    await expect(collectEntityPages(root, SAMPLE_PROFILE)).rejects.toThrow(/foo-bar/);
  });
});
