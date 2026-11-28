/**
 * @file test/indexed/verify.test.ts
 * @description Full verification never reports a missing authority as
 * green (R36). On an active `local-indexed` project, a lost catalog manifest
 * fails `wiki.catalog.verify()` while ordinary listings refuse; a workspace
 * operation-catalog store is verified even when its workspace directory is
 * absent, and fails when its manifest is lost. The storage inventory sums
 * EVERY store: retained leaves are measured (a leftover temp included), an
 * unopenable one is unmeasured, and a store that failed before its segment
 * check is named; either makes the inventory incomplete, never falsely total.
 */

import { mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { operationCatalogStore } from "../../src/history/operation-catalog.js";
import { appendCatalogRecordLocked, createCatalogRecord } from "../../src/operation-bundles/catalog-store.js";
import { createWikiCore } from "../../src/sdk/core.js";
import { activateIndexed } from "../catalog/helpers.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-indexed-verify-")); await activateIndexed(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const INDEXED = () => path.join(root, ".llmwiki", "indexed");
/** Rename `store`'s manifest aside (retained, not deleted). */
const loseManifest = (store: string) => rename(path.join(INDEXED(), store, "manifest.json"), path.join(INDEXED(), store, "manifest.json.lost"));

describe("a lost active catalog", () => {
  it("fails full verification while listings refuse", async () => {
    const wiki = createWikiCore({ root });
    expect((await wiki.catalog.verify()).ok).toBe(true);
    await loseManifest("catalog");
    const report = await wiki.catalog.verify();
    expect(report.ok).toBe(false);
    expect(report.stores.find((store) => store.store === "catalog")?.problems.join()).toContain("catalog is missing");
    await expect(wiki.listPages()).rejects.toThrow();
  });
});

describe("a workspace catalog store without its workspace directory", () => {
  const record = createCatalogRecord({ logicalRecordId: "l-ghost", mutationId: `opm_${"d".repeat(64)}`, payload: {}, createdAt: "2026-10-26T00:00:00.000Z" });

  it("is still verified, and a lost manifest fails instead of being omitted", async () => {
    expect(await appendCatalogRecordLocked(root, "ghost", record)).toBe("created");
    await rm(path.join(root, ".llmwiki", "workspaces"), { recursive: true, force: true });
    const wiki = createWikiCore({ root });
    const clean = await wiki.catalog.verify();
    expect([clean.ok, clean.storesChecked]).toEqual([true, 5]);
    await loseManifest(operationCatalogStore("ghost"));
    expect(await readdir(path.join(INDEXED(), operationCatalogStore("ghost")))).toContain("manifest.json.lost");
    const report = await wiki.catalog.verify();
    expect(report.ok).toBe(false);
    expect(report.stores[0]?.store).toBe(`catalog store ${operationCatalogStore("ghost")}`);
  });
});

describe("the storage inventory of a full verification", () => {
  it("sums every store, measures retained leaves, and reports what it could not measure", async () => {
    const wiki = createWikiCore({ root });
    const clean = await wiki.catalog.verify();
    expect(clean.storage).toMatchObject({ storesMeasured: clean.storesChecked, retainedLeaves: 0, unmeasuredLeaves: 0, complete: true });
    expect(clean.storage.referencedBytes).toBeGreaterThan(0);
    await writeFile(path.join(INDEXED(), "events", "manifest.json.0123abcd.tmp"), "x".repeat(7));
    expect((await wiki.catalog.verify()).storage).toMatchObject({ retainedLeaves: 1, retainedBytes: 7, complete: true });
    await symlink(path.join(root, "elsewhere"), path.join(INDEXED(), "events", "r9-0-00000000.seg"));
    expect((await wiki.catalog.verify()).storage).toMatchObject({ retainedLeaves: 2, unmeasuredLeaves: 1, complete: false });
  });

  it("names a store whose verification failed before its inventory, instead of reporting a complete total", async () => {
    await loseManifest("catalog");
    const storage = (await createWikiCore({ root }).catalog.verify()).storage;
    expect(storage).toMatchObject({ unmeasuredStores: { count: 1, sample: ["catalog"] }, complete: false });
  });
});
