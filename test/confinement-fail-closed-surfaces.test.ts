/**
 * @file test/confinement-fail-closed-surfaces.test.ts
 * @description Regression tests for B4 + B5: confinement errors that previously
 * crashed export (B4: symlinked `wiki/graph`) or lint (B5: symlinked `.llmwiki`)
 * instead of failing closed.
 *
 * B4 — `GraphDirConfinementError` must be caught in `exportRelationViews` so a
 * symlinked `wiki/graph` returns undefined (no relations) rather than crashing.
 *
 * B5 — `resolveConfinedPrivateDir` must throw a typed `PrivateDirConfinementError`
 * (not a bare `Error`) so `checkEventChain` / event read surfaces can map it to a
 * fail-closed finding instead of crashing `lint`.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { exportJson } from "../src/commands/export.js";
import { checkEventChain } from "../src/profile/event-lint.js";
import { appendEvent } from "../src/events/store.js";
import { LLMWIKI_DIR, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import { seedTestsRelation } from "./fixtures/profile-fixtures.js";
import {
  makeConfineRoots,
  cleanupConfineRoots,
  plantGraphDirSymlink,
  type ConfineRoots,
} from "./fixtures/graph-store-confine.js";

let ctx: ConfineRoots;

beforeEach(async () => { ctx = await makeConfineRoots("confine-fail-closed"); });
afterEach(async () => { await cleanupConfineRoots(ctx); });

/** Plant `.llmwiki` as a symlink to the out-of-tree dir. */
async function plantPrivateDirSymlink(): Promise<void> {
  await symlink(ctx.outside, path.join(ctx.root, LLMWIKI_DIR), "dir");
}

/** Assert that checkEventChain returns a fail-closed error finding (never throws). */
async function expectPrivateDirConfinedFinding(): Promise<void> {
  await rm(path.join(ctx.root, LLMWIKI_DIR), { recursive: true, force: true });
  await plantPrivateDirSymlink();
  const findings = await checkEventChain(ctx.root);
  expect(Array.isArray(findings)).toBe(true);
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].severity).toBe("error");
}

/** Seed a relation then replace wiki/graph with an escaping symlink. */
async function plantGraphDirSymlinkAfterSeed(): Promise<void> {
  await seedTestsRelation(ctx.root, "ablation-batch-size", "sparse-routing");
  await rm(path.join(ctx.root, WIKI_GRAPH_DIR), { recursive: true, force: true });
  await plantGraphDirSymlink(ctx);
}

describe("B4 — symlinked wiki/graph: export fails closed (no crash)", () => {
  it("export omits relations and does NOT throw when wiki/graph is a symlink", async () => {
    await plantGraphDirSymlinkAfterSeed();
    const doc = await exportJson(ctx.root);
    // Must not throw; relations must be omitted (undefined), not crash
    expect("relations" in (doc.profile ?? {})).toBe(false);
  });

  it("export still returns a valid profile block without relations", async () => {
    await plantGraphDirSymlink(ctx);
    const doc = await exportJson(ctx.root);
    expect(doc.profile?.profileId).toBe("research-lite");
    expect(doc.profile?.entityPages).toBeDefined();
    expect("relations" in (doc.profile ?? {})).toBe(false);
  });
});

describe("B5 — symlinked .llmwiki: checkEventChain fails closed (no crash)", () => {
  it("fails closed with a prior event (readHeadAnchor exercised)", async () => {
    // Emit an event so the store exists and readHeadAnchor is exercised
    await appendEvent(ctx.root, { type: "relation-create", origin: "sdk", payload: {}, at: "2024-01-01T00:00:00Z" });
    await expectPrivateDirConfinedFinding();
  });

  it("fails closed with no prior events (empty log path)", async () => {
    // No events emitted; the head-anchor check still exercises resolveConfinedPrivateDir
    await expectPrivateDirConfinedFinding();
  });
});
