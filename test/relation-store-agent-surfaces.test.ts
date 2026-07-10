/**
 * @file test/relation-store-agent-surfaces.test.ts
 * @description The "one surface honest, another silently drops the same failure"
 * regression. When the relation store is broken (here: a too-new schemaVersion),
 * STATUS already surfaces it as a profile problem. The two AGENT-FACING surfaces
 * must now do the SAME instead of failing closed by silent omission:
 *
 *  - EXPORT: `exportJson().profile` carries a relation-store problem (problems
 *    non-empty, problemTotal counts it) — not a clean block with no relations.
 *  - CONTEXT: `buildContextPack` emits a `relation-store-unavailable` warning —
 *    the agent SEES relations are unavailable, not a silent no-relations primary.
 *
 * Regression: a HEALTHY non-default project (valid relations) gains NO
 * store-unavailable problem/warning on either surface.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportJson } from "../src/commands/export.js";
import { buildContextPack } from "../src/context/build.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import {
  buildResearchLiteRelationsProject,
  seedTestsRelation,
} from "./fixtures/profile-fixtures.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-agent-surface-"));
  await buildResearchLiteRelationsProject(root);
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Seed a too-new (schemaVersion 99) relation-store header so reads fail closed. */
async function seedTooNewStore(): Promise<void> {
  await mkdir(path.join(root, WIKI_GRAPH_DIR), { recursive: true });
  await writeFile(path.join(root, RELATIONS_FILE), '{"kind":"relation-store-header","schemaVersion":99}\n');
}

describe("broken relation store — export surfaces a problem", () => {
  it("includes a relation-store problem instead of a silent clean block", async () => {
    await seedTooNewStore();
    const doc = await exportJson(root);
    const problems = doc.profile?.problems ?? [];
    expect(problems.some((p) => p.kind === "relation-store")).toBe(true);
    expect(doc.profile?.problemTotal).toBeGreaterThanOrEqual(1);
  });
});

describe("broken relation store — context surfaces a warning", () => {
  it("emits a relation-store-unavailable warning, not a silent no-relations pack", async () => {
    await seedTooNewStore();
    const pack = await buildContextPack({ root, prompt: "anything" });
    expect(pack.warnings.some((w) => w.code === "relation-store-unavailable")).toBe(true);
  });
});

describe("healthy relation store — no store-unavailable problem/warning", () => {
  beforeEach(async () => { await seedTestsRelation(root, "ablation-batch-size", "sparse-routing"); });

  it("export carries the live relation, no store-unavailable problem", async () => {
    const doc = await exportJson(root);
    expect(doc.profile?.relations).toHaveLength(1);
    const problems = doc.profile?.problems ?? [];
    expect(problems.some((p) => p.kind === "relation-store")).toBe(false);
  });

  it("context emits no relation-store-unavailable warning", async () => {
    const pack = await buildContextPack({ root, prompt: "MixtureOfExperts" });
    expect(pack.warnings.some((w) => w.code === "relation-store-unavailable")).toBe(false);
  });
});
