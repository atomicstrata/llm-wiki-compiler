/**
 * @file test/graph-dir-confine-surfaces.test.ts
 * @description Audit FIX F5: a symlinked `wiki/graph` DIR throws the SHARED typed
 * `GraphDirConfinementError`, which BOTH the relation and event surfaces map to a
 * fail-closed finding/problem — never an uncaught crash. Before the fix the dir
 * resolver threw a generic `Error` that only the relation-LEAF mapping covered,
 * so a symlinked graph dir crashed event lint and the profile summary.
 *
 * Covers: event lint emits a fail-closed finding; relation lint too; status /
 * profile summary surface a problem (no throw); a normal real graph dir works.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { collectStatus } from "../src/status/collect.js";
import { lint } from "../src/linter/index.js";
import { seedTestsRelation } from "./fixtures/profile-fixtures.js";
import {
  makeConfineRoots,
  cleanupConfineRoots,
  plantGraphDirSymlink,
  expectStoreProblemNoCounts,
  type ConfineRoots,
} from "./fixtures/graph-store-confine.js";

let ctx: ConfineRoots;
beforeEach(async () => { ctx = await makeConfineRoots("graph-dir-confine"); });
afterEach(async () => { await cleanupConfineRoots(ctx); });

describe("FIX F5 — symlinked wiki/graph DIR maps to a finding/problem, not a crash", () => {
  it("event lint emits a fail-closed finding instead of crashing", async () => {
    await plantGraphDirSymlink(ctx);
    const { results } = await lint(ctx.root);
    expect(results.some((r) => r.rule === "event-store-graph-dir")).toBe(true);
  });

  it("relation lint emits a fail-closed finding instead of crashing", async () => {
    await plantGraphDirSymlink(ctx);
    const { results } = await lint(ctx.root);
    expect(results.some((r) => r.rule === "relation-store-graph-dir")).toBe(true);
  });

  it("status / profile summary surfaces a problem and does not throw", async () => {
    await plantGraphDirSymlink(ctx);
    const status = await collectStatus(ctx.root);
    expectStoreProblemNoCounts(status.profile, /graph directory rejected/i);
  });

  it("a normal real graph dir still lints / counts (regression)", async () => {
    await seedTestsRelation(ctx.root, "ablation-batch-size", "sparse-routing");
    const { results } = await lint(ctx.root);
    expect(results.some((r) => /graph-dir/.test(r.rule))).toBe(false);
    const status = await collectStatus(ctx.root);
    expect(status.profile?.relationTotal).toBe(1);
  });
});
