/**
 * @file test/relation-live-valid.test.ts
 * @description Unit coverage for the shared `readLiveValidRelations` reader: it
 * returns the LATEST live relation per id filtered to those still valid against
 * the given profile. A relation whose type the profile no longer declares is
 * OMITTED (retained on disk, never surfaced as live) — the single semantics the
 * export/viewer surfaces now share.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readLiveValidRelations } from "../src/relations/live-valid.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
  RESEARCH_LITE_RELATIONS_PROFILE,
  RESEARCH_LITE_PROFILE,
} from "./fixtures/profile-fixtures.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-live-valid-"));
  await buildResearchLiteRelationsProject(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("readLiveValidRelations", () => {
  it("returns a seeded relation still valid against the profile", async () => {
    const seeded = await seedTestsRelation(root, "a", "b");
    const valid = await readLiveValidRelations(root, RESEARCH_LITE_RELATIONS_PROFILE as ProfilePack);
    expect(valid.map((rel) => rel.id)).toEqual([seeded.id]);
  });

  it("omits a stored relation the profile no longer declares", async () => {
    await seedTestsRelation(root, "a", "b");
    const valid = await readLiveValidRelations(root, RESEARCH_LITE_PROFILE as ProfilePack);
    expect(valid).toEqual([]);
  });
});
