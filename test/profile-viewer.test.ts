/**
 * @file test/profile-viewer.test.ts
 * @description Tests for the additive `profile` counts/problems block on the
 * viewer snapshot (NO rendering — counts and problems only).
 *
 * Covers: (a) a DEFAULT project's snapshot has NO `profile` key and its legacy
 * `counts.concepts`/`counts.queries` stay scoped to wiki/concepts + wiki/queries;
 * (b) a NON-default project surfaces `profile` with profileId, digest, per-type
 * entity counts, and collector problems.
 *
 * `counts.concepts`/`counts.queries` stay scoped to the two legacy directories
 * even once typed entity pages reach `snapshot.pages` — the count block is about
 * the compiled wiki corpus, and a typed page is neither a concept nor a query.
 * The page LIST is a different question and does carry them; see
 * `test/viewer-typed-pages.test.ts`.
 */

import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { writeMarkdownPage, seedSampleNotesProject } from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-viewer-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("viewer snapshot — default profile", () => {
  it("has no profile block and counts scoped to concepts/queries", async () => {
    await writeMarkdownPage(root, CONCEPTS_DIR, "alpha", "---\ntitle: Alpha\n---\nBody.");
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.profile).toBeUndefined();
    expect(snapshot.counts.concepts).toBe(1);
    expect(snapshot.counts.queries).toBe(0);
  });
});

describe("viewer snapshot — non-default profile", () => {
  beforeEach(async () => {
    await seedSampleNotesProject(root);
  });

  it("adds a profile block with per-type entity counts and digest", async () => {
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.profile?.profileId).toBe("sample");
    expect(typeof snapshot.profile?.digest).toBe("string");
    expect(snapshot.profile?.entityCounts).toEqual({ notes: 1 });
  });

  it("leaves legacy counts scoped to concepts/queries while listing the entity page", async () => {
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.counts.concepts).toBe(0);
    expect(snapshot.counts.queries).toBe(0);
    expect(snapshot.pages.map((p) => p.id)).toEqual(["notes/first-note"]);
    expect(snapshot.pages[0].entityType).toBe("notes");
  });

  it("exposes the declared entity types as the page route's allowlist", async () => {
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.entityTypes).toEqual(["notes"]);
  });

  it("surfaces collector problems for a contract violation", async () => {
    await writeMarkdownPage(root, "wiki/notes", "no-title", "---\nslug: no-title\n---\nNo title.");
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.profile?.problems?.some((p) => p.message.includes("title"))).toBe(true);
  });
});
