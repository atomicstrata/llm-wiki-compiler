/**
 * @file test/catalog/sync-batch-bytes.test.ts
 * @description The bounded caller's byte flush of a catalog reconciliation
 * (`syncCatalogFrom` with `maxBatchBytes`): a batch is committed BEFORE an
 * entry whose rows would pass the byte bound, so a tiny bound commits once
 * per changed entry, and the reconciliation still ends complete (a following
 * incumbent reconciliation finds nothing to change). Without options the
 * incumbent grouping is unchanged: one commit for a handful of changes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { walkCatalogFiles } from "../../src/catalog/files.js";
import { openActiveCatalog } from "../../src/catalog/routes.js";
import { syncCatalog, syncCatalogFrom, type SyncOptions } from "../../src/catalog/sync.js";
import { activateIndexed, pageText, writeCorpus } from "./helpers.js";

/** Pages edited before each reconciliation. */
const EDITED = 5;
/** Durable segment commits on the external test volume; measured, explicit. */
const SYNC_TIMEOUT_MS = 120_000;

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-sync-bytes-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Edit the first {@link EDITED} concept pages (`round` keeps each edit distinct). */
async function editPages(round: number): Promise<void> {
  for (let at = 0; at < EDITED; at += 1) {
    await writeFile(path.join(root, "wiki", "concepts", `page-${String(at).padStart(5, "0")}.md`), pageText(`Page ${at} edit ${round}`));
  }
}

/** Reconcile through the ONE body with `options`; returns what it did and how many commits it published. */
async function syncWith(options: SyncOptions): Promise<{ reprojected: number; commits: number }> {
  const store = await openActiveCatalog(root);
  const walk = await walkCatalogFiles(root, store.counters, []);
  const entries = (async function* () { yield* walk.entries; })();
  const result = await syncCatalogFrom(root, store, undefined, { entries, uncatalogued: { count: walk.uncatalogued.length, sample: walk.uncatalogued.slice(0, 10) } }, options);
  return { reprojected: result.reprojected, commits: result.store.manifest.generation - store.manifest.generation };
}

describe("the byte flush of a bounded reconciliation", () => {
  it("commits before each entry that would pass the bound, and ends complete", async () => {
    await writeCorpus(root, 12, 0);
    await activateIndexed(root);
    await editPages(1);
    const bounded = await syncWith({ maxBatchBytes: 1 });
    expect(bounded.reprojected).toBe(EDITED);
    // One pre-flush before every changed entry but the first, then the final commit.
    expect(bounded.commits).toBe(EDITED);
    const after = await syncCatalog(root, await openActiveCatalog(root));
    expect([after.reprojected, after.removed]).toEqual([0, 0]);
  }, SYNC_TIMEOUT_MS);

  it("keeps the incumbent grouping without options", async () => {
    await writeCorpus(root, 12, 0);
    await activateIndexed(root);
    await editPages(1);
    expect(await syncWith({})).toEqual({ reprojected: EDITED, commits: 1 });
  }, SYNC_TIMEOUT_MS);
});
