/**
 * @file src/indexed/verify.ts
 * @description FULL read-only verification of every `local-indexed` store:
 * the catalog, the event and relation histories, every workspace operation
 * catalog, and the vectors. Explicit O(stored data) work, run by the
 * `activation-verify` preparation step and on request (`wiki.catalog.verify()`,
 * `llmwiki catalog verify`); never by a narrow operation.
 *
 * INVENTORY. Every workspace directory is accounted for: one with an
 * imported store, a leftover store directory or an incumbent catalog file is
 * verified (a lost manifest or an unimported catalog file fails), and an
 * unreadable workspaces directory fails rather than being taken as empty.
 * Every `opcat-*` store directory is accounted for too, even when its
 * workspace directory is absent: its manifest must name the workspace its
 * directory is named for. A missing catalog store fails.
 * The report keeps every count, and the storage inventory summed over ALL
 * stores (`storage`: referenced and retained bytes, unmeasured stores and
 * leaves), but only a bounded sample of store results.
 */

import { openCatalog } from "../catalog/meta.js";
import { verifyCatalogStore } from "../catalog/verify.js";
import { backupAbsent, PROBLEM_SAMPLE } from "../history/contracts.js";
import { verifyEventHistory, type HistoryVerification } from "../history/events-read.js";
import { verifyOperationCatalog, verifyRelationHistory } from "../history/history-verify.js";
import { legacyCatalogPath, openOperationCatalog, OPERATION_CATALOG_STORE_PREFIX, operationCatalogStore } from "../history/operation-catalog.js";
import { INDEXED_DIR } from "../segments/contracts.js";
import { newCounters } from "../segments/counters.js";
import { diskSegmentStoreIo, storeMayHoldLeaves } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { verifyVectors } from "../vectors/verify.js";
import { CSTATE_CAPABILITY, CSTATE_STORE } from "../cstate/contracts.js";
import { openCompileState } from "../cstate/store.js";
import { verifyCompileState } from "../cstate/verify.js";
import { capabilityStatus } from "../scale/capability-status.js";

/** Most workspaces (and indexed store directories) one verification lists. */
const MAX_WORKSPACES = 10_000;

/** One store's verification, labelled. */
export interface StoreCheckV1 extends HistoryVerification { readonly store: string }

/**
 * The on-disk inventory of EVERY verified store, summed before any sampling.
 * A store whose verification failed before its segment check has no
 * inventory: it is named under `unmeasuredStores` and `complete` is false,
 * as it is when any store left a retained leaf unmeasured.
 */
export interface IndexedStorageV1 {
  readonly storesMeasured: number;
  readonly unmeasuredStores: { readonly count: number; readonly sample: readonly string[] };
  readonly segments: number;
  readonly referencedBytes: number;
  readonly retainedLeaves: number;
  readonly retainedBytes: number;
  readonly unmeasuredLeaves: number;
  readonly complete: boolean;
}

/** What one full verification found (this response only). */
export interface IndexedVerificationV1 {
  readonly ok: boolean;
  readonly storesChecked: number;
  readonly storesFailed: number;
  /** Retained and referenced bytes across every store (not only the sample). */
  readonly storage: IndexedStorageV1;
  /** A bounded sample of store results, failures first. */
  readonly stores: readonly StoreCheckV1[];
}

/** A failed check carrying `error`'s message. */
function failed(store: string, error: unknown): StoreCheckV1 {
  return { store, ok: false, records: 0, problemCount: 1, problems: [error instanceof Error ? error.message : String(error)] };
}

/** Run one check, turning a refusal into a failed result. */
async function check(store: string, work: () => Promise<HistoryVerification>): Promise<StoreCheckV1> {
  try { return { store, ...(await work()) }; } catch (error) { return failed(store, error); }
}

/** The workspaces that hold or held operation-catalog authority; throws when the directory cannot be listed. */
async function catalogWorkspaces(root: string): Promise<string[]> {
  const listing = await listConfinedDirBounded(root, ".llmwiki/workspaces", MAX_WORKSPACES);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") throw new Error("the operation workspaces directory cannot be listed (unavailable, oversized or not a directory)");
  const ids: string[] = [];
  for (const entry of listing.entries) {
    if (entry.kind !== "directory" || entry.name.startsWith(".")) continue;
    const store = await openOperationCatalog(root, entry.name);
    const holds = store.exists || (await storeMayHoldLeaves(store.io)) || !(await backupAbsent(root, legacyCatalogPath(root, entry.name), newCounters()));
    if (holds) ids.push(entry.name);
  }
  return ids;
}

/**
 * The workspaces named by `opcat-*` store directories under `.llmwiki/indexed`,
 * so a store whose workspace directory is absent or lost is still verified.
 * Each store must have a manifest whose workspace hashes to its name; one
 * that does not (or cannot be read) is a failure, never an omission.
 */
async function storeWorkspaces(root: string): Promise<{ ids: string[]; failures: StoreCheckV1[] }> {
  const listing = await listConfinedDirBounded(root, INDEXED_DIR, MAX_WORKSPACES);
  if (listing.kind === "absent") return { ids: [], failures: [] };
  if (listing.kind !== "ok") throw new Error("the indexed stores directory cannot be listed (unavailable, oversized or not a directory)");
  const ids: string[] = [];
  const failures: StoreCheckV1[] = [];
  for (const entry of listing.entries.filter((item) => item.name.startsWith(OPERATION_CATALOG_STORE_PREFIX))) {
    try {
      const store = await SegmentStore.open(diskSegmentStoreIo(root, entry.name));
      const workspaceId = store.exists ? (store.meta as { workspaceId?: unknown }).workspaceId : undefined;
      if (typeof workspaceId !== "string" || operationCatalogStore(workspaceId) !== entry.name) throw new Error("its manifest is missing or names another workspace");
      ids.push(workspaceId);
    } catch (error) {
      failures.push(failed(`catalog store ${entry.name}`, error));
    }
  }
  return { ids, failures };
}

/** Verify every workspace operation catalog found by either inventory. */
async function verifyWorkspaceCatalogs(root: string): Promise<StoreCheckV1[]> {
  const results: StoreCheckV1[] = [];
  const found = new Set<string>();
  try { (await catalogWorkspaces(root)).forEach((id) => found.add(id)); } catch (error) { results.push(failed("workspaces", error)); }
  try {
    const stores = await storeWorkspaces(root);
    stores.ids.forEach((id) => found.add(id));
    results.push(...stores.failures);
  } catch (error) { results.push(failed("indexed stores", error)); }
  for (const workspaceId of [...found].sort()) results.push(await check(`catalog ${workspaceId}`, () => verifyOperationCatalog(root, workspaceId)));
  return results;
}

/** Sum the inventories of all `results`, naming the stores that have none. */
function aggregateStorage(results: readonly StoreCheckV1[]): IndexedStorageV1 {
  const totals = { storesMeasured: 0, segments: 0, referencedBytes: 0, retainedLeaves: 0, retainedBytes: 0, unmeasuredLeaves: 0 };
  const unmeasured: string[] = [];
  for (const result of results) {
    const storage = result.storage;
    if (storage === undefined) { unmeasured.push(result.store); continue; }
    totals.storesMeasured += 1;
    totals.segments += storage.segments;
    totals.referencedBytes += storage.referencedBytes;
    totals.retainedLeaves += storage.retainedLeaves;
    totals.retainedBytes += storage.retainedBytes;
    totals.unmeasuredLeaves += storage.unmeasuredLeaves;
  }
  const unmeasuredStores = { count: unmeasured.length, sample: unmeasured.slice(0, PROBLEM_SAMPLE) };
  return { ...totals, unmeasuredStores, complete: unmeasured.length === 0 && totals.unmeasuredLeaves === 0 };
}

/**
 * Whether the segmented compile state must be verified: on a LIVE project its
 * capability is held (the scale record is read, failing closed); in an ARCHIVE
 * tree (which carries no scale record) the archive's own store list names it.
 * Either way a compile-state store physically present is verified too.
 */
async function compileStateHeld(root: string, archivedStores?: ReadonlySet<string>): Promise<boolean> {
  const listed = archivedStores === undefined ? (await capabilityStatus(root, CSTATE_CAPABILITY)) !== "absent" : archivedStores.has(CSTATE_STORE);
  if (listed) return true;
  const store = await openCompileState(root);
  return store.exists || (await storeMayHoldLeaves(store.io));
}

/** How a verification reads its root. */
export interface IndexedVerificationOptions {
  /**
   * INTERNAL, for the backup and restore only: `root` is an archive tree (no
   * scale record), and these are the stores the archive's own authority list
   * names. Never offered by the ordinary verification surfaces.
   */
  readonly archivedStores?: ReadonlySet<string>;
}

/** Verify every indexed store of `root`. */
export async function verifyIndexedStores(root: string, options: IndexedVerificationOptions = {}): Promise<IndexedVerificationV1> {
  const results: StoreCheckV1[] = [
    await check("catalog", async () => verifyCatalogStore(await openCatalog(root))),
    await check("events", () => verifyEventHistory(root)),
    await check("relations", () => verifyRelationHistory(root)),
    await check("vectors", () => verifyVectors(root)),
  ];
  results.push(...(await verifyWorkspaceCatalogs(root)));
  if (await compileStateHeld(root, options.archivedStores)) results.push(await check("cstate", () => verifyCompileState(root)));
  const failures = results.filter((result) => !result.ok);
  const sample = [...failures, ...results.filter((result) => result.ok)].slice(0, PROBLEM_SAMPLE);
  return { ok: failures.length === 0, storesChecked: results.length, storesFailed: failures.length, storage: aggregateStorage(results), stores: sample };
}
