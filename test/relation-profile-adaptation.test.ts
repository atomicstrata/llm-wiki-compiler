/**
 * @file test/relation-profile-adaptation.test.ts
 * @description Read-surface re-validation of STORED relations against the
 * CURRENT profile (audit FIX 4): after a profile change drops a relation type,
 * the on-disk record is RETAINED but reclassified — lint flags it
 * `relation-profile-invalid`, status does NOT count it as live (surfaces a
 * problem), and export omits it from the live `RelationView`s. A still-valid
 * relation is counted / exported normally.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { lint } from "../src/linter/index.js";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
  RESEARCH_LITE_PROFILE,
} from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-adapt-"));
  await buildResearchLiteRelationsProject(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Overwrite the profile file with the relation-LESS profile (drops `tests`). */
async function dropRelationType(): Promise<void> {
  await writeFile(
    path.join(root, ".llmwiki", "profile.json"),
    `${JSON.stringify(RESEARCH_LITE_PROFILE, null, 2)}\n`,
    "utf8",
  );
}

describe("stored relation re-validated against the current profile (FIX 4)", () => {
  it("lint flags a relation whose type the profile no longer declares", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await dropRelationType();
    const { results } = await lint(root);
    const finding = results.find((r) => r.rule === "relation-profile-invalid");
    expect(finding?.message).toMatch(/no longer valid against the profile/);
  });

  it("status does not count the invalid relation as live; surfaces a problem", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await dropRelationType();
    const status = await collectStatus(root);
    expect("relationCounts" in (status.profile ?? {})).toBe(false);
    expect(status.profile?.problems?.some((p) => /no longer valid against the current profile/.test(p.message))).toBe(true);
  });

  it("export omits the invalid relation from the live RelationViews", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await dropRelationType();
    const doc = await exportJson(root);
    expect("relations" in (doc.profile ?? {})).toBe(false);
  });

  it("a still-valid relation is counted and exported normally", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const status = await collectStatus(root);
    const doc = await exportJson(root);
    expect(status.profile?.relationCounts).toEqual({ tests: 1 });
    expect(doc.profile?.relations).toHaveLength(1);
  });
});
