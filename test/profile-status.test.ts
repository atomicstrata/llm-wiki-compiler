/**
 * @file test/profile-status.test.ts
 * @description Tests for profile-aware `collectStatus` (CLP Phase 0/1, Task 6).
 *
 * Verifies two invariants:
 *   (a) DEFAULT profile — the returned `WikiStatus` matches today's envelope
 *       exactly (pages.{concepts,queries,total} + the stale/orphaned/pending
 *       fields) and the optional `profile` block is ABSENT (`undefined`), so
 *       default JSON envelopes never drift;
 *   (b) NON-DEFAULT profile — `pages` stays LEGACY-scoped (counts only the
 *       literal wiki/concepts + wiki/queries dirs, typically 0), and the
 *       `profile` block carries the profileId, digest, and the per-entity-type
 *       page counts derived from `collectEntityPages`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
import { PROFILE_PROBLEM_CAP } from "../src/profile/block.js";
import { PROFILE_FILE, CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";

let root = "";

/** A non-default profile declaring two entity types under wiki/. */
const SAMPLE_PROFILE = {
  schemaVersion: 1,
  profileId: "sample",
  displayName: "Sample",
  entities: {
    notes: { directory: "wiki/notes" },
    tasks: { directory: "wiki/tasks" },
  },
};

/** Write a `.llmwiki/profile.json` containing the serialized `profile`. */
async function writeProfile(profile: unknown): Promise<void> {
  const filePath = path.join(root, PROFILE_FILE);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(profile), "utf8");
}

/**
 * Write a markdown page under `dir`. A frontmatter `title` is included so the
 * page is counted by the legacy `collectPageSummaries` (which requires a title
 * and a non-orphaned flag); omit it to write a bare entity-only page.
 */
async function writePage(dir: string, stem: string, withTitle = false): Promise<void> {
  await mkdir(dir, { recursive: true });
  const fm = withTitle ? `---\ntitle: ${stem}\n---\n\n` : "";
  await writeFile(path.join(dir, `${stem}.md`), `${fm}# ${stem}\n`);
}

/** Make `wiki/notes` a symlink to an out-of-tree dir so the collector flags it invalid. */
async function symlinkNotesDirOutOfTree(): Promise<void> {
  await mkdir(path.join(root, "elsewhere"), { recursive: true });
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await symlink(path.join(root, "elsewhere"), path.join(root, "wiki/notes"));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-status-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("collectStatus — default profile", () => {
  it("omits the profile block and keeps legacy pages counts", async () => {
    await writePage(path.join(root, CONCEPTS_DIR), "alpha", true);
    await writePage(path.join(root, QUERIES_DIR), "beta", true);
    const result = await collectStatus(root);
    expect(result.profile).toBeUndefined();
    expect(result.pages).toEqual({ concepts: 1, queries: 1, total: 2 });
    expect("profile" in result).toBe(false);
  });
});

describe("collectStatus — non-default profile", () => {
  it("scopes pages to legacy dirs and reports per-type entity counts", async () => {
    await writeProfile(SAMPLE_PROFILE);
    await writePage(path.join(root, "wiki/notes"), "first-note");
    await writePage(path.join(root, "wiki/notes"), "second-note");
    await writePage(path.join(root, "wiki/tasks"), "do-thing");
    const result = await collectStatus(root);
    expect(result.pages).toEqual({ concepts: 0, queries: 0, total: 0 });
    expect(result.profile?.profileId).toBe("sample");
    expect(typeof result.profile?.digest).toBe("string");
    expect(result.profile?.entityCounts).toEqual({ notes: 2, tasks: 1 });
  });

  it("reports zero counts for declared-but-empty entity types", async () => {
    await writeProfile(SAMPLE_PROFILE);
    const result = await collectStatus(root);
    expect(result.profile?.entityCounts).toEqual({ notes: 0, tasks: 0 });
    expect(result.pages.total).toBe(0);
  });

  it("omits the problems key when every entity page is clean", async () => {
    await writeProfile(SAMPLE_PROFILE);
    await writePage(path.join(root, "wiki/notes"), "first-note");
    const result = await collectStatus(root);
    expect(result.profile && "problems" in result.profile).toBe(false);
  });
});

describe("collectStatus — surfaces non-default problems (never silent)", () => {
  it("reports a symlinked entity dir as a problem instead of a silent 0", async () => {
    await writeProfile(SAMPLE_PROFILE);
    await symlinkNotesDirOutOfTree();
    const result = await collectStatus(root);
    expect(result.profile?.problems?.some((p) => /invalid/i.test(p.message))).toBe(true);
    expect(result.profile?.entityCounts.notes).toBe(0);
  });

  it("does not crash and still collects siblings when one page is non-slug-safe", async () => {
    await writeProfile(SAMPLE_PROFILE);
    await writePage(path.join(root, "wiki/notes"), "Bad Name");
    await writePage(path.join(root, "wiki/notes"), "good-note");
    const result = await collectStatus(root);
    expect(result.profile?.entityCounts.notes).toBe(1);
    expect(result.profile?.problems).toHaveLength(1);
  });

  it("caps problems at PROFILE_PROBLEM_CAP while problemTotal reports the full count", async () => {
    const overCap = PROFILE_PROBLEM_CAP + 5;
    await writeProfile({ ...SAMPLE_PROFILE, entities: { notes: { directory: "wiki/notes", requiredFields: ["title"], fields: { title: { type: "string" } } } } });
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    for (let i = 0; i < overCap; i++) {
      const slug = `n-${String(i).padStart(3, "0")}`;
      await writeFile(path.join(root, "wiki/notes", `${slug}.md`), `---\nslug: ${slug}\n---\nNo title.`);
    }
    const result = await collectStatus(root);
    expect(result.profile?.problems).toHaveLength(PROFILE_PROBLEM_CAP);
    expect(result.profile?.problemTotal).toBe(overCap);
  });

  it("gives field-violation problems a project-relative path (never absolute)", async () => {
    await writeProfile({ ...SAMPLE_PROFILE, entities: { notes: { directory: "wiki/notes", requiredFields: ["title"], fields: { title: { type: "string" } } } } });
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await writeFile(path.join(root, "wiki/notes", "untitled.md"), "---\nslug: untitled\n---\nNo title.");
    const result = await collectStatus(root);
    const problem = result.profile!.problems![0];
    expect(problem.path).toBe("wiki/notes/untitled.md");
    expect(problem.path?.startsWith("/")).toBe(false);
  });

  it("omits path on a directory-level (invalid-directory) problem", async () => {
    await writeProfile(SAMPLE_PROFILE);
    await symlinkNotesDirOutOfTree();
    const result = await collectStatus(root);
    const dirProblem = result.profile!.problems!.find((p) => p.kind === "invalid-directory");
    expect(dirProblem).toBeDefined();
    expect("path" in dirProblem!).toBe(false);
  });
});
