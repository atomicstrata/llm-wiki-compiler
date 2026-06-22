/**
 * @file test/relation-store-symlink-surfaces.test.ts
 * @description Audit FIX F3: a symlinked store-file leaf
 * (`wiki/graph/relations.jsonl`) makes the no-follow reader throw
 * `RelationStoreSymlinkError`. Before this fix only `RelationStoreCorruptError`
 * /`RelationStoreTooNewError` were mapped, so the symlink error was UNCAUGHT and
 * crashed status / lint / export.
 *
 * Each read surface must now map the symlink error into its SAME relation-store
 * problem channel (status: a capped `problem`; lint: a fail-closed finding;
 * export: omit relations) and never throw. A normal real-file store still
 * counts / lints / exports (regression).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectStatus } from "../src/status/collect.js";
import { lint } from "../src/linter/index.js";
import { exportJson } from "../src/commands/export.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
} from "./fixtures/profile-fixtures.js";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rel-symlink-surface-"));
  outsideDir = await mkdtemp(path.join(tmpdir(), "rel-symlink-outside-"));
  await buildResearchLiteRelationsProject(root);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
});

/** Plant `relations.jsonl` as a symlink to a header-bearing out-of-tree file. */
async function plantLeafSymlink(): Promise<void> {
  await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
  const outside = path.join(outsideDir, "outside-store.jsonl");
  await writeFile(outside, '{"kind":"relation-store-header","schemaVersion":1}\n', "utf8");
  await symlink(outside, path.join(root, RELATIONS_FILE));
}

describe("FIX F3 — symlinked relation store leaf maps to read surfaces", () => {
  it("status surfaces a relation-store problem instead of crashing", async () => {
    await plantLeafSymlink();
    const status = await collectStatus(root);
    expect(status.profile?.problems?.some((p) => /relation store/i.test(p.message))).toBe(true);
    expect("relationCounts" in (status.profile ?? {})).toBe(false);
  });

  it("lint emits a fail-closed finding instead of throwing", async () => {
    await plantLeafSymlink();
    const { results } = await lint(root);
    expect(results.some((r) => r.rule === "relation-store-symlink")).toBe(true);
  });

  it("export omits relations and does not throw", async () => {
    await plantLeafSymlink();
    const doc = await exportJson(root);
    expect("relations" in (doc.profile ?? {})).toBe(false);
  });

  it("a normal real-file store still counts / lints / exports (regression)", async () => {
    await seedTestsRelation(root, "ablation-batch-size", "sparse-routing");
    const status = await collectStatus(root);
    expect(status.profile?.relationTotal).toBe(1);
    const { results } = await lint(root);
    expect(results.some((r) => r.rule === "relation-store-symlink")).toBe(false);
    const doc = await exportJson(root);
    expect(doc.profile?.relations).toHaveLength(1);
  });
});
