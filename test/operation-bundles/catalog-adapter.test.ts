/**
 * @file test/operation-bundles/catalog-adapter.test.ts
 * @description Task 4 tests for the catalog adapter: append-shaped observation by
 * mutation identity, create-then-applied through the whole-file-rewrite seam, and
 * idempotent retry.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { catalogAdapter } from "../../src/operation-bundles/adapters/catalog.js";
import { CATALOG_PAYLOAD as PAYLOAD, catalogMutation, makeBinding, makeContext, publishPayload, WORKSPACE_ID } from "./adapter-fixtures.js";
import { readCatalogStore } from "../../src/operation-bundles/catalog-store.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "cat-adapter-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("catalogAdapter", () => {
  it("observes not-applied on a fresh catalog", async () => {
    const set = makeBinding();
    expect((await catalogAdapter.observe(makeContext(root, catalogMutation(set), set))).outcome).toBe("not-applied");
  });

  it("appends a record and then observes applied", async () => {
    const set = makeBinding();
    await publishPayload(root, set.bundleId, PAYLOAD);
    const ctx = makeContext(root, catalogMutation(set), set);
    expect((await catalogAdapter.apply(ctx)).status).toBe("applied");
    expect((await catalogAdapter.observe(ctx)).outcome).toBe("applied");
    const store = await readCatalogStore(root, WORKSPACE_ID);
    expect(store.status === "ok" && store.records).toHaveLength(1);
  });

  it("is idempotent on an exact retry", async () => {
    const set = makeBinding();
    await publishPayload(root, set.bundleId, PAYLOAD);
    const ctx = makeContext(root, catalogMutation(set), set);
    await catalogAdapter.apply(ctx);
    expect((await catalogAdapter.apply(ctx)).status).toBe("skipped-idempotent");
  });
});
