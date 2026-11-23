/**
 * @file src/compiler/batch/residual-catalog.ts
 * @description The catalog step of a batch compile's RESIDUAL phase: the
 * incumbent end-of-compile reconciliation of a `local-indexed` catalog
 * (`reconcileCatalogIfIndexed`), with bounded memory.
 *
 * The incumbent walk (`walkCatalogInto`: every catalogued tree, each
 * directory stamped before it is listed, one directory entry at a time) is
 * spilled into the run's external sort (code-unit key order, the order the
 * incumbent sorts its walk into), and the sorted stream is handed to the ONE
 * reconciliation body (`syncCatalogFrom`) under the batch bounds
 * (`./entity-bound.ts`: entity page bodies capped, batches capped in bytes too).
 * Uncatalogued paths are only counted, with the incumbent bounded sample. The
 * source tree is walked no deeper than the batch listing walks it
 * (`MAX_SOURCE_DEPTH`); a deeper tree refuses.
 *
 * The walk's directory lookups (an entity type sharing a walked directory)
 * read the directory entries spilled as `cwd:<key>`. The step runs before the
 * index, which reads the typed catalog it refreshes; the incumbent runs it
 * last, but the catalog does not hold the index or the MOC, so the result is
 * the same. A crash redoes the step; the reconciliation itself is resumable.
 */

import { SAMPLE_SIZE } from "../../catalog/contracts.js";
import { walkCatalogInto, type WalkedEntry } from "../../catalog/files.js";
import { openActiveCatalog } from "../../catalog/routes.js";
import { catalogWalkTypes, syncCatalogFrom, type UncataloguedTally } from "../../catalog/sync.js";
import { MAX_KEY_CHARS } from "../../segments/contracts.js";
import { MAX_SOURCE_DEPTH } from "./detect.js";
import { BATCH_CATALOG_SYNC } from "./entity-bound.js";
import { ExternalSorter } from "./external-sort.js";
import type { BatchRun } from "./run-store.js";

/** The run-row prefix of a walked directory entry. */
const WALKED_DIR_PREFIX = "cwd:";

/** Code-unit order of walked entries by key. */
const byKey = (a: WalkedEntry, b: WalkedEntry): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Whether `key` names a directory row (`d:`) that fits a run-row key. */
const spillableDirKey = (key: string): boolean => key.startsWith("d:") && WALKED_DIR_PREFIX.length + key.length <= MAX_KEY_CHARS;

/** Walk the catalogued trees into the sorter; returns the uncatalogued tally. */
async function walkInto(run: BatchRun, sorter: ExternalSorter<WalkedEntry>, counters: Parameters<typeof walkCatalogInto>[1], types: Parameters<typeof walkCatalogInto>[3]): Promise<UncataloguedTally> {
  const sample: string[] = [];
  let count = 0;
  await walkCatalogInto(run.root, counters, {
    entry: async (entry) => {
      await sorter.add(entry);
      if (spillableDirKey(entry.key)) await run.put(`${WALKED_DIR_PREFIX}${entry.key}`, entry);
    },
    uncatalogued: async (relPath) => {
      count += 1;
      if (sample.length < SAMPLE_SIZE) sample.push(relPath);
    },
    find: async (key) => (spillableDirKey(key) ? ((await run.get(`${WALKED_DIR_PREFIX}${key}`)) as WalkedEntry | undefined) : undefined),
  }, types, MAX_SOURCE_DEPTH);
  return { count, sample };
}

/** Reconcile the catalog with the files, through the bounded walk. */
export async function reconcileCatalogBounded(run: BatchRun): Promise<void> {
  const { loaded, types } = await catalogWalkTypes(run.root);
  const store = await openActiveCatalog(run.root);
  const sorter = new ExternalSorter<WalkedEntry>(run, "cws:", byKey);
  const uncatalogued = await walkInto(run, sorter, store.counters, types);
  await syncCatalogFrom(run.root, store, loaded, { entries: sorter.sorted(), uncatalogued }, BATCH_CATALOG_SYNC);
}
