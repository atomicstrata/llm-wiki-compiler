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
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
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
});
