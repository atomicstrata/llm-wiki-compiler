/**
 * @file test/history/operation-catalog.test.ts
 * @description The segmented workspace operation catalog of an active
 * `local-indexed` project on real disk, through the incumbent catalog store
 * API (operation bundles are product-gated, so on an eligible project this is
 * a store/composition proof, not an end-user journey). An imported catalog
 * reads back identically; an append validates lineage through point lookups
 * with the incumbent refusals; a replay is `same` with no write; a racing
 * publication is the incumbent `CatalogConcurrentChangeError`; the gate's
 * inventory counts records from the manifest alone; a mutation index pointing
 * at another record is caught; full verification passes.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { verifyOperationCatalog } from "../../src/history/history-verify.js";
import { catalogRecordByMutation, openOperationCatalog } from "../../src/history/operation-catalog.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import {
  appendCatalogRecordLocked, CatalogConcurrentChangeError, createCatalogRecord, readCatalogStore, type CatalogRecord,
} from "../../src/operation-bundles/catalog-store.js";
import type { CatalogRecordId, MutationId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { SegmentStore } from "../../src/segments/store.js";
import { activateIndexed } from "../catalog/helpers.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-opcat-seg-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const WS = "research";

/**
 * The inventory case's own budget under the explicit `slow-durable-storage`
 * profile: its 40 records are seeded through the incumbent whole-file writer,
 * five durable flushes each (200 flushes, about 275 s on slow external storage),
 * before the activation's own durable commits; together they exceed that
 * profile's 300 s. A functional allowance for slow storage only, never a
 * reference budget.
 */
const INVENTORY_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** That budget when slow storage is selected; otherwise undefined, so the profile's per-test budget applies. */
const inventoryTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? INVENTORY_SLOW_STORAGE_TIMEOUT_MS
  : undefined;

/** One deterministic mutation identity. */
const mutation = (seed: string): MutationId => `opm_${createHash("sha256").update(seed).digest("hex")}`;
/** One canonical record for `seed`, rooted at `logical` unless it supersedes. */
function record(seed: string, logical = `logical-${seed}`, supersedes?: CatalogRecordId): CatalogRecord {
  return createCatalogRecord({
    logicalRecordId: logical, mutationId: mutation(seed), payload: { seed }, createdAt: "2026-10-26T00:00:00.000Z",
    ...(supersedes === undefined ? {} : { supersedesRecordId: supersedes }),
  });
}

/** Seed `count` legacy records through the incumbent whole-file writer, then activate. */
async function seededIndexed(count: number): Promise<CatalogRecord[]> {
  const records = Array.from({ length: count }, (_, at) => record(`s${at}`));
  for (const item of records) await appendCatalogRecordLocked(root, WS, item);
  await activateIndexed(root);
  return records;
}

describe("imported catalog", () => {
  it("reads back identically, appends with lineage, replays as same, and keeps the legacy file", async () => {
    const seeded = await seededIndexed(5);
    const bytes = await readFile(operationPaths(root, WS).catalogFile);
    expect(await readCatalogStore(root, WS)).toEqual({ status: "ok", records: seeded });
    const successor = record("next", seeded[0]!.logicalRecordId, seeded[0]!.physicalRecordId);
    expect(await appendCatalogRecordLocked(root, WS, successor)).toBe("created");
    const counters = newCounters();
    expect(await observeIo(counters, () => appendCatalogRecordLocked(root, WS, successor))).toBe("same");
    expect(counters.manifestsPublished).toBe(0);
    expect(await readFile(operationPaths(root, WS).catalogFile)).toEqual(bytes);
    expect(await verifyOperationCatalog(root, WS)).toMatchObject({ ok: true, records: 6 });
  });

  it("refuses the incumbent lineage violations through point lookups", async () => {
    const [first] = await seededIndexed(1);
    await expect(appendCatalogRecordLocked(root, WS, record("fork", first!.logicalRecordId))).rejects.toThrow("root fork");
    await expect(appendCatalogRecordLocked(root, WS, record("orphan", "x", `cat_${"0".repeat(64)}` as CatalogRecordId))).rejects.toThrow();
    await expect(appendCatalogRecordLocked(root, WS, record("move", "other", first!.physicalRecordId))).rejects.toThrow("changes logical identity");
    await appendCatalogRecordLocked(root, WS, record("succ1", first!.logicalRecordId, first!.physicalRecordId));
    await expect(appendCatalogRecordLocked(root, WS, record("succ2", first!.logicalRecordId, first!.physicalRecordId))).rejects.toThrow("supersession fork");
  });
});

describe("conditional publication and bounded inventory", () => {
  it("turns a racing publication into CatalogConcurrentChangeError with nothing published", async () => {
    await seededIndexed(1);
    const original = SegmentStore.prototype.commit;
    vi.spyOn(SegmentStore.prototype, "commit").mockImplementationOnce(async function (this: SegmentStore, input) {
      await appendCatalogRecordLocked(root, WS, record("racer"));
      return original.call(this, input);
    });
    await expect(appendCatalogRecordLocked(root, WS, record("loser"))).rejects.toBeInstanceOf(CatalogConcurrentChangeError);
    const store = await openOperationCatalog(root, WS);
    expect([await catalogRecordByMutation(store, mutation("racer")) !== undefined, await catalogRecordByMutation(store, mutation("loser"))]).toEqual([true, undefined]);
  });

  it("counts catalog records for the gate's inventory from the manifest without reading records", async () => {
    await seededIndexed(40);
    const counters = newCounters();
    const inventory = await observeIo(counters, () => scanOperationInventory(root));
    expect(inventory.workspaces.get(WS)?.catalogRecords).toBe(40);
    expect([counters.blocksRead, counters.rowsDecoded]).toEqual([0, 0]);
  }, inventoryTimeoutMs);
});
