/**
 * @file test/relation-surface.test.ts
 * @description Tests for relation READ surfacing (Phase 4 PR6) — relation
 * counts in the additive status/viewer profile block and path-safe
 * `RelationView`s in the JSON export profile block.
 *
 * Covers: status surfaces `relationCounts` (per type) + `relationTotal` for a
 * project with relations; export surfaces the `RelationView`s (no absolute
 * paths, no evidence file paths); a corrupt store surfaces a status `problem`
 * (fail-closed, no crash); and a DEFAULT project plus a relation-less
 * non-default project emit NO relation fields (status/export byte-identical).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectStatus } from "../src/status/collect.js";
import { exportJson } from "../src/commands/export.js";
import { RELATIONS_FILE, CONCEPTS_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteProject,
  buildResearchLiteRelationsProject,
  seedTestsRelation,
} from "./fixtures/profile-fixtures.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "relation-surface-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("status profile block — relation counts", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("reports relationCounts per type and relationTotal", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    await seedTestsRelation(root, "ablation-batch-size", "curriculum-pretraining");
    const status = await collectStatus(root);
    expect(status.profile?.relationCounts).toEqual({ tests: 2 });
    expect(status.profile?.relationTotal).toBe(2);
  });

  it("surfaces a corrupt store as a problem rather than crashing", async () => {
    await mkdir(path.join(root, path.dirname(RELATIONS_FILE)), { recursive: true });
    await writeFile(path.join(root, RELATIONS_FILE), '{"kind":"relation-store-header","schemaVersion":99}\n');
    const status = await collectStatus(root);
    expect(status.profile?.problems?.some((p) => /relation store/i.test(p.message))).toBe(true);
    expect("relationCounts" in (status.profile ?? {})).toBe(false);
  });
});

describe("export profile block — relation views (path-safe)", () => {
  beforeEach(async () => await buildResearchLiteRelationsProject(root));

  it("includes a RelationView per relation with no absolute paths", async () => {
    const ref = await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const doc = await exportJson(root);
    expect(doc.profile?.relations).toHaveLength(1);
    const view = doc.profile!.relations![0];
    expect(view).toMatchObject({
      id: ref.id, type: "tests",
      from: "experiments/ablation-batch-size", to: "ideas/sparse-routing",
    });
    const json = JSON.stringify(doc.profile?.relations);
    expect(json).not.toContain(root);
    expect(json).not.toContain("evidence");
  });
});

describe("relation fields — omitted on default / relation-less paths", () => {
  it("a DEFAULT project emits no relationCounts or relations keys", async () => {
    await writeFile(path.join(root, "x.md"), "x");
    await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
    const status = await collectStatus(root);
    const doc = await exportJson(root);
    expect(status.profile).toBeUndefined();
    expect("profile" in doc).toBe(false);
  });

  it("a relation-LESS non-default project emits no relation fields", async () => {
    await buildResearchLiteProject(root);
    const status = await collectStatus(root);
    const doc = await exportJson(root);
    expect("relationCounts" in (status.profile ?? {})).toBe(false);
    expect("relationTotal" in (status.profile ?? {})).toBe(false);
    expect("relations" in (doc.profile ?? {})).toBe(false);
  });
});
