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
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
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

/** Create the SAMPLE_PROFILE entity directories (`wiki/notes`, `wiki/tasks`). */
async function makeSampleDirs(): Promise<void> {
  await mkdir(path.join(root, "wiki/notes"), { recursive: true });
  await mkdir(path.join(root, "wiki/tasks"), { recursive: true });
}

/**
 * Collect SAMPLE_PROFILE and assert it yielded no refs and exactly one problem
 * of `kind` under `entityType`. Returns the lone problem for further checks.
 */
async function expectSoleProblem(
  kind: string,
  entityType: string,
): Promise<{ message: string }> {
  const { refs, problems } = await collectEntityPages(root, SAMPLE_PROFILE);
  expect(refs).toEqual([]);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ kind, entityType });
  return problems[0];
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
  beforeEach(makeSampleDirs);

  it("mints branded ids for slug-safe stems across entity types", async () => {
    await writePage(path.join(root, "wiki/notes"), "first-note", "first-note");
    await writePage(path.join(root, "wiki/tasks"), "do-thing");
    const { refs, problems } = await collectEntityPages(root, SAMPLE_PROFILE);
    const byId = Object.fromEntries(refs.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(["notes/first-note", "tasks/do-thing"]);
    expect(byId["notes/first-note"]).toMatchObject({ entityType: "notes", slug: "first-note", directory: "wiki/notes" });
    expect(problems).toEqual([]);
  });

  it("records a slug-mismatch problem (does not throw, drops only the bad ref)", async () => {
    await writePage(path.join(root, "wiki/notes"), "first-note", "other-slug");
    await writePage(path.join(root, "wiki/tasks"), "do-thing");
    const { refs, problems } = await collectEntityPages(root, SAMPLE_PROFILE);
    expect(refs.map((r) => r.id)).toEqual(["tasks/do-thing"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "slug-mismatch", entityType: "notes" });
    expect(problems[0].message).toMatch(/does not match file stem/);
  });
});

describe("collectEntityPages — non-slug-safe stems become problems", () => {
  beforeEach(makeSampleDirs);

  it("records a non-slug-safe-filename problem with a rename hint, never slugifying", async () => {
    await writePage(path.join(root, "wiki/notes"), "Foo Bar");
    const problem = await expectSoleProblem("non-slug-safe-filename", "notes");
    expect(problem.message).toMatch(/foo-bar/);
  });

  it("collects valid siblings even when one page is non-slug-safe", async () => {
    await writePage(path.join(root, "wiki/notes"), "Foo Bar");
    await writePage(path.join(root, "wiki/notes"), "good-note");
    const { refs, problems } = await collectEntityPages(root, SAMPLE_PROFILE);
    expect(refs.map((r) => r.id)).toEqual(["notes/good-note"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("non-slug-safe-filename");
  });
});

describe("collectEntityPages — invalid directory surfaced", () => {
  it("flags a symlinked entity dir as invalid-directory (not a silent skip)", async () => {
    const realTarget = path.join(root, "elsewhere");
    await mkdir(realTarget, { recursive: true });
    await mkdir(path.join(root, "wiki"), { recursive: true });
    await mkdir(path.join(root, "wiki/tasks"), { recursive: true });
    await symlink(realTarget, path.join(root, "wiki/notes"));
    await expectSoleProblem("invalid-directory", "notes");
  });
});

/** A profile whose `notes` type requires `title` and constrains `status`. */
const CONTRACT_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "contract",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { status: { type: "enum", enum: ["open", "done"] } },
    },
  },
};

describe("collectEntityPages — field contract enforced as problems", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
  });

  it("records a field-violation for a missing required field, keeping the ref", async () => {
    await writeFile(path.join(root, "wiki/notes/no-title.md"), "# no-title\n");
    const { refs, problems } = await collectEntityPages(root, CONTRACT_PROFILE);
    expect(refs.map((r) => r.id)).toEqual(["notes/no-title"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "field-violation", entityType: "notes" });
    expect(problems[0].message).toMatch(/title/);
  });

  it("records a field-violation for an out-of-set enum value", async () => {
    await writeFile(path.join(root, "wiki/notes/bad-status.md"), "---\ntitle: T\nstatus: nope\n---\n");
    const { refs, problems } = await collectEntityPages(root, CONTRACT_PROFILE);
    expect(refs.map((r) => r.id)).toEqual(["notes/bad-status"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("field-violation");
    expect(problems[0].message).toMatch(/status/);
  });

  it("produces no problems for a contract-satisfying page", async () => {
    await writeFile(path.join(root, "wiki/notes/good.md"), "---\ntitle: T\nstatus: open\n---\n");
    const { refs, problems } = await collectEntityPages(root, CONTRACT_PROFILE);
    expect(refs.map((r) => r.id)).toEqual(["notes/good"]);
    expect(problems).toEqual([]);
  });
});
