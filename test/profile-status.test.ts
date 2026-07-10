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
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
import { appendEvent } from "../src/events/store.js";
import { PROFILE_PROBLEM_CAP } from "../src/profile/block.js";
import { PROFILE_FILE, CONCEPTS_DIR, QUERIES_DIR, EVENTS_FILE } from "../src/utils/constants.js";

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

/** A profile requiring `title` on every `notes` page. */
const REQUIRED_TITLE_PROFILE = {
  schemaVersion: 1,
  profileId: "required-title",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { title: { type: "string" } },
    },
  },
};

describe("collectStatus — entityCounts excludes field-violating pages", () => {
  it("counts only the valid page when one valid and one field-violating page exist", async () => {
    await writeProfile(REQUIRED_TITLE_PROFILE);
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    // Valid page: has the required `title` field
    await writeFile(path.join(root, "wiki/notes/valid-note.md"), "---\ntitle: Valid\n---\n");
    // Invalid page: missing the required `title` field
    await writeFile(path.join(root, "wiki/notes/no-title.md"), "# no-title\n");
    const result = await collectStatus(root);
    expect(result.profile?.entityCounts.notes).toBe(1); // only the valid page
    expect(result.profile?.problemTotal).toBeGreaterThanOrEqual(1); // invalid page still surfaced
  });

  it("counts zero when the only entity page is field-violating", async () => {
    await writeProfile(REQUIRED_TITLE_PROFILE);
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await writeFile(path.join(root, "wiki/notes/no-title.md"), "# no-title\n");
    const result = await collectStatus(root);
    expect(result.profile?.entityCounts.notes).toBe(0);
    expect(result.profile?.problems).toHaveLength(1);
  });

  it("counts all pages when all entity pages are valid (regression)", async () => {
    await writeProfile(REQUIRED_TITLE_PROFILE);
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    await writeFile(path.join(root, "wiki/notes/note-a.md"), "---\ntitle: A\n---\n");
    await writeFile(path.join(root, "wiki/notes/note-b.md"), "---\ntitle: B\n---\n");
    const result = await collectStatus(root);
    expect(result.profile?.entityCounts.notes).toBe(2);
    expect(result.profile && "problems" in result.profile).toBe(false);
  });
});

/** Emit a chained event into the project's `wiki/graph` store. */
const emitEvent = (n: string): Promise<unknown> =>
  appendEvent(root, { type: "relation-create", origin: "sdk", payload: { n }, at: "2024-01-01T00:00:00Z" });

/** Assert a fail-closed event store: an `event-store` problem present, the count suppressed. */
async function expectEventStoreProblem(): Promise<void> {
  const result = await collectStatus(root);
  expect(result.profile?.problems?.some((p) => p.kind === "event-store")).toBe(true);
  expect(result.profile && "eventCount" in result.profile).toBe(false);
}

describe("collectStatus — event store (count + fail-closed problem)", () => {
  beforeEach(async () => await writeProfile(SAMPLE_PROFILE));

  it("surfaces eventCount for a healthy chain and no event-store problem", async () => {
    await emitEvent("a");
    await emitEvent("b");
    const result = await collectStatus(root);
    expect(result.profile?.eventCount).toBe(2);
    expect(result.profile?.problems?.some((p) => p.kind === "event-store")).toBeFalsy();
  });

  it("omits eventCount for an event-less non-default profile", async () => {
    const result = await collectStatus(root);
    expect(result.profile && "eventCount" in result.profile).toBe(false);
  });

  it("reports a tampered chain as a problem and suppresses the count (not silent)", async () => {
    await emitEvent("a");
    await emitEvent("b");
    const lines = (await readFile(path.join(root, EVENTS_FILE), "utf8")).split("\n").filter(Boolean);
    await writeFile(path.join(root, EVENTS_FILE), lines.slice(0, -1).join("\n") + "\n"); // truncate
    await expectEventStoreProblem();
  });

  it("reports an unreadable (too-new) store as a problem without crashing", async () => {
    await mkdir(path.join(root, path.dirname(EVENTS_FILE)), { recursive: true });
    await writeFile(path.join(root, EVENTS_FILE), '{"kind":"event-store-header","schemaVersion":99}\n');
    await expectEventStoreProblem();
  });
});
