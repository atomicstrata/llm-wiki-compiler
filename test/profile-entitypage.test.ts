/**
 * @file test/profile-entitypage.test.ts
 * @description Tests for the content-carrying `EntityPage` model returned by
 * `collectEntityPages` (CLP Phase 1b, Task 0).
 *
 * Where the identity-only assertions live in `profile-collect.test.ts`, this
 * suite proves the NEW content guarantees: each collected page carries its
 * branded `id`/`slug` AND the scan's `frontmatter`/`body`, and `title` is the
 * frontmatter title when present (undefined otherwise). It also re-confirms the
 * fail-soft contract at the new shape — a non-slug-safe filename yields a
 * problem (no page, no throw) — and that the default profile still throws the
 * programming-error guard.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectEntityPages, EntityCollectError } from "../src/profile/collect.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/** A small non-default profile declaring one `notes` entity type. */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "entitypage-sample",
  entities: { notes: { directory: "wiki/notes" } },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-entitypage-"));
  await mkdir(path.join(root, "wiki/notes"), { recursive: true });
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("collectEntityPages — content-carrying EntityPage", () => {
  it("carries branded identity plus frontmatter, body, and title", async () => {
    await writeFile(
      path.join(root, "wiki/notes/alpha.md"),
      "---\ntitle: Alpha Note\ntag: x\n---\n\nHello body.\n",
    );
    const { pages, problems } = await collectEntityPages(root, PROFILE);
    expect(problems).toEqual([]);
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page).toMatchObject({ id: "notes/alpha", slug: "alpha", entityType: "notes" });
    expect(page.frontmatter).toMatchObject({ title: "Alpha Note", tag: "x" });
    expect(page.body).toContain("Hello body.");
    expect(page.title).toBe("Alpha Note");
  });

  it("leaves title undefined when frontmatter has no title", async () => {
    await writeFile(path.join(root, "wiki/notes/beta.md"), "Just a body, no frontmatter.\n");
    const { pages } = await collectEntityPages(root, PROFILE);
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBeUndefined();
    expect(pages[0].frontmatter).toEqual({});
    expect(pages[0].body).toContain("Just a body");
  });
});

describe("collectEntityPages — fail-soft at the content shape", () => {
  it("yields a problem (no page, no throw) for a non-slug-safe filename", async () => {
    await writeFile(path.join(root, "wiki/notes/Bad Name.md"), "# Bad Name\n");
    const { pages, problems } = await collectEntityPages(root, PROFILE);
    expect(pages).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "non-slug-safe-filename", entityType: "notes" });
  });

  it("still throws the programming-error guard for the default profile", async () => {
    await expect(collectEntityPages(root, DEFAULT_PROFILE)).rejects.toBeInstanceOf(EntityCollectError);
  });
});
