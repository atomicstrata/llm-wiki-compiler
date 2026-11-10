/**
 * @file test/operation-bundles/projection-adapter.test.ts
 * @description Task 4 tests for the projection adapter: a deterministic,
 * network-free render whose bytes match the manifest output digest, applied and
 * idempotent through the founding projection store.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { projectionAdapter } from "../../src/operation-bundles/adapters/projection.js";
import { makeBinding, makeContext, projectionMutation } from "./adapter-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "proj-adapter-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("projectionAdapter", () => {
  it("observes not-applied on a fresh store", async () => {
    const set = makeBinding();
    expect((await projectionAdapter.observe(makeContext(root, projectionMutation(set), set))).outcome).toBe("not-applied");
  });

  it("renders deterministically, writes, and then observes applied", async () => {
    const set = makeBinding();
    const ctx = makeContext(root, projectionMutation(set), set);
    expect((await projectionAdapter.preflight(ctx))).toEqual({ status: "ready" });
    expect((await projectionAdapter.apply(ctx)).status).toBe("applied");
    expect((await projectionAdapter.observe(ctx)).outcome).toBe("applied");
    expect((await projectionAdapter.verify(ctx)).status).toBe("verified");
  });

  it("is idempotent on an exact re-render", async () => {
    const set = makeBinding();
    const ctx = makeContext(root, projectionMutation(set), set);
    await projectionAdapter.apply(ctx);
    expect((await projectionAdapter.apply(ctx)).status).toBe("skipped-idempotent");
  });
});
