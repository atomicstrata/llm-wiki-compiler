/**
 * @file src/indexed/gc.ts
 * @description SEGMENT COLLECTION of a `local-indexed` project: a read-only
 * PREVIEW that produces a plan, and an APPLY that deletes exactly what a still
 * current plan names.
 *
 * PLAN. The plan binds the canonical project root, the exact pins, and per
 * store the exact current manifest bytes and the exact candidate set
 * (`./gc-inventory.ts`): its count, bytes and a digest of every candidate's
 * name, size, device, inode and nanosecond mtime.
 *
 * APPLY, in this order, refusing with nothing deleted at any failed step:
 * 1. the operator must assert `readersOffline`: processes of builds without
 *    reader leases (and external tools) are invisible to the census;
 * 2. this process must not have read the stores (`asCollector`), and no
 *    snapshot of them may be opened in this process while it runs;
 * 3. under the maintenance acquisition (`./maintenance-lock.ts`: the raw
 *    project lock, so no manifest can be published, and every custody leg
 *    of the gate checked read-only), the reader-lease census must find no
 *    live or uncertain lease;
 * 4. the WHOLE project is re-inventoried: no blocker anywhere, the same store
 *    set, pins, manifests and candidate digests as the plan.
 * Only then is each candidate unlinked, after re-checking its identity, and
 * each store directory synced once. A failure part-way is `indexed_gc_partial`
 * with the exact counts deleted so far. A crash part-way leaves a subset of
 * unreferenced leaves deleted: nothing referenced or pinned is ever touched,
 * and a new preview plans the rest.
 */

import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { INDEXED_DIR, STORE_NAME_PATTERN } from "../segments/contracts.js";
import { canonicalRoot, readerCensus, type ReaderCensusV1 } from "../segments/reader-lease.js";
import { fsyncConfinedDirectory, unlinkConfinedLeafIfIdentity } from "../utils/confined-delete.js";
import { inventoryStore, listStores, MAX_LEAVES, MAX_STORES, type CandidateIdentityV1, type StoreInventoryV1 } from "./gc-inventory.js";
import { withMaintenanceLock } from "./maintenance-lock.js";
import { readPins } from "./pins.js";

const PLAN_FORMAT = "llmwiki-indexed-gc-plan";
const HEX64 = /^[0-9a-f]{64}$/;
/** An ISO timestamp, generously bounded. */
const MAX_TIMESTAMP_CHARS = 64;

/**
 * Why a collection stopped. Every code except `indexed_gc_partial` is a
 * PREFLIGHT refusal: nothing was deleted. `indexed_gc_partial` means the
 * deletion phase failed part-way (a leaf or its directory changed, an unlink
 * or directory sync failed): the error's `partial` counts what WAS deleted,
 * across every store already processed. Only unreferenced, unpinned
 * segments were ever deleted, so the logical stores are unchanged either way.
 */
export type IndexedGcErrorCode =
  | "indexed_gc_offline_unconfirmed" | "indexed_gc_readers_active" | "indexed_gc_blocked" | "indexed_gc_plan_stale" | "indexed_gc_plan_invalid"
  | "indexed_gc_partial";

/** A typed collection refusal; `partial` is present exactly on `indexed_gc_partial`. */
export class IndexedGcError extends Error {
  constructor(readonly code: IndexedGcErrorCode, message: string, readonly partial?: GcDeletedV1) {
    super(`${code}: ${message}`);
    this.name = "IndexedGcError";
  }
}

/** What a collection deleted, per store and in total. */
export interface GcDeletedV1 {
  readonly deletedLeaves: number;
  readonly deletedBytes: number;
  readonly stores: readonly { readonly store: string; readonly deletedLeaves: number; readonly deletedBytes: number }[];
}

/** One store's binding in a plan. */
export interface GcPlanStoreV1 {
  readonly store: string;
  readonly manifestSha256: string | null;
  readonly candidateCount: number;
  readonly candidateBytes: number;
  readonly candidateDigest: string;
}

/** A collection plan: pass it back unchanged to apply. */
export interface GcPlanV1 {
  readonly format: typeof PLAN_FORMAT;
  readonly version: 1;
  readonly rootDigest: string;
  readonly pinsDigest: string;
  readonly createdAt: string;
  readonly stores: readonly GcPlanStoreV1[];
}

/** What a preview found. */
export interface GcPreviewV1 {
  readonly plan: GcPlanV1;
  /** Whether apply could accept this plan now (no blocker). */
  readonly admissible: boolean;
  readonly blockers: readonly string[];
  readonly pins: readonly string[];
  readonly reclaimableLeaves: number;
  readonly reclaimableBytes: number;
  readonly stores: readonly (Omit<StoreInventoryV1, "candidates" | "blockers"> & { readonly sample: readonly string[] })[];
}

/** What an apply deleted. */
export interface GcApplyV1 extends GcDeletedV1 {
  /** Leases of exited processes the census ignored. */
  readonly staleLeases: number;
}

/** The whole project's inventory. */
interface ProjectInventory { readonly rootDigest: string; readonly pinsDigest: string; readonly pins: readonly string[]; readonly stores: readonly StoreInventoryV1[]; readonly blockers: readonly string[] }

/** Inventory every store and pin of the project at canonical `root`. */
async function projectInventory(root: string): Promise<ProjectInventory> {
  const listed = await listStores(root);
  const pins = await readPins(root, new Set(listed.stores));
  const stores: StoreInventoryV1[] = [];
  for (const store of listed.stores) stores.push(await inventoryStore(root, store, pins.protectedBy.get(store) ?? new Set()));
  const blockers = [...listed.blockers, ...pins.blockers, ...stores.flatMap((entry) => entry.blockers)];
  return { rootDigest: createHash("sha256").update(root).digest("hex"), pinsDigest: pins.digest, pins: pins.labels, stores, blockers };
}

/** The plan that binds `inventory`. */
function planOf(inventory: ProjectInventory): GcPlanV1 {
  const stores = inventory.stores.map(({ store, manifestSha256, candidates, candidateBytes, candidateDigest }) => ({ store, manifestSha256, candidateCount: candidates.length, candidateBytes, candidateDigest }));
  return { format: PLAN_FORMAT, version: 1, rootDigest: inventory.rootDigest, pinsDigest: inventory.pinsDigest, createdAt: new Date().toISOString(), stores };
}

/** Preview a collection: read-only, no lease, no lock. */
export async function previewGc(root: string): Promise<GcPreviewV1> {
  const inventory = await projectInventory(await canonicalRoot(root));
  const stores = inventory.stores.map(({ candidates, blockers: _blockers, ...rest }) => ({ ...rest, sample: candidates.slice(0, 5).map((c) => c.name) }));
  return {
    plan: planOf(inventory), admissible: inventory.blockers.length === 0, blockers: inventory.blockers, pins: inventory.pins,
    reclaimableLeaves: inventory.stores.reduce((sum, s) => sum + s.candidates.length, 0), reclaimableBytes: inventory.stores.reduce((sum, s) => sum + s.candidateBytes, 0), stores,
  };
}

/** A whole number in `[0, max]`. */
function isCount(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** A lowercase hex SHA-256. */
const isHex64 = (value: unknown): boolean => typeof value === "string" && HEX64.test(value);

/** Whether `value` is an object with exactly `keys`. */
function hasExactKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
}

/** One plan store entry, strictly. */
function parsePlanStore(value: unknown): GcPlanStoreV1 {
  const entry = value as Record<string, unknown>;
  const valid = hasExactKeys(value, "candidateBytes,candidateCount,candidateDigest,manifestSha256,store")
    && typeof entry.store === "string" && STORE_NAME_PATTERN.test(entry.store) && (entry.manifestSha256 === null || isHex64(entry.manifestSha256))
    && isCount(entry.candidateCount, MAX_LEAVES) && isCount(entry.candidateBytes, Number.MAX_SAFE_INTEGER) && isHex64(entry.candidateDigest);
  if (!valid) throw new IndexedGcError("indexed_gc_plan_invalid", "a plan store entry is malformed");
  return entry as unknown as GcPlanStoreV1;
}

/** Whether `value` has a version 1 plan's header. */
function isPlanHeader(value: unknown): value is Record<string, unknown> & { stores: unknown[] } {
  if (!hasExactKeys(value, "createdAt,format,pinsDigest,rootDigest,stores,version") || value.format !== PLAN_FORMAT || value.version !== 1) return false;
  const timestamp = typeof value.createdAt === "string" && value.createdAt.length <= MAX_TIMESTAMP_CHARS;
  return timestamp && isHex64(value.rootDigest) && isHex64(value.pinsDigest) && Array.isArray(value.stores) && value.stores.length <= MAX_STORES;
}

/** Parse a plan strictly. */
function parseGcPlan(value: unknown): GcPlanV1 {
  if (!isPlanHeader(value)) throw new IndexedGcError("indexed_gc_plan_invalid", "the plan is not a version 1 indexed collection plan");
  const stores = value.stores.map(parsePlanStore);
  if (new Set(stores.map((s) => s.store)).size !== stores.length) throw new IndexedGcError("indexed_gc_plan_invalid", "the plan names a store twice");
  if (!isCount(stores.reduce((sum, s) => sum + s.candidateBytes, 0), Number.MAX_SAFE_INTEGER)) throw new IndexedGcError("indexed_gc_plan_invalid", "the plan's byte total is out of range");
  return { ...(value as unknown as GcPlanV1), stores };
}

/** Refuse unless `inventory` is exactly what `plan` bound. */
function assertCurrent(plan: GcPlanV1, inventory: ProjectInventory): void {
  if (inventory.blockers.length > 0) throw new IndexedGcError("indexed_gc_blocked", inventory.blockers.slice(0, 5).join("; "));
  const now = planOf(inventory);
  const same = now.rootDigest === plan.rootDigest && now.pinsDigest === plan.pinsDigest && now.stores.length === plan.stores.length
    && now.stores.every((entry, at) => JSON.stringify(entry) === JSON.stringify(plan.stores[at]));
  if (!same) throw new IndexedGcError("indexed_gc_plan_stale", "the project changed since the plan was made (a commit, a pin, or a candidate leaf); preview again");
}

/** Refuse unless the census found only stale leases. */
function assertNoReaders(census: ReaderCensusV1): void {
  const busy = [...census.live, ...census.uncertain];
  if (busy.length > 0) throw new IndexedGcError("indexed_gc_readers_active", `reader leases are live or cannot be classified: ${busy.slice(0, 5).join(", ")}; stop those processes (MCP servers, viewers, watchers) and preview again`);
}

/** Whether `stat` is still exactly `candidate`. */
export function sameIdentity(candidate: CandidateIdentityV1): (stat: BigIntStats) => boolean {
  return (stat) => String(stat.size) === candidate.size && String(stat.dev) === candidate.dev && String(stat.ino) === candidate.ino && String(stat.mtimeNs) === candidate.mtimeNs;
}

/** Mutable deletion progress across stores. */
interface Progress { deletedLeaves: number; deletedBytes: number; stores: { store: string; deletedLeaves: number; deletedBytes: number }[] }

/**
 * Unlink `candidates` from `store` into `progress`, each through the confined
 * identity-bound unlink (canonical parent and exact identity re-checked at the
 * last seam); sync the directory once. A changed leaf throws.
 */
async function deleteCandidates(root: string, store: string, candidates: readonly CandidateIdentityV1[], progress: Progress): Promise<void> {
  const dir = path.join(root, INDEXED_DIR, store);
  const entry = { store, deletedLeaves: 0, deletedBytes: 0 };
  progress.stores.push(entry);
  try {
    for (const candidate of candidates) {
      if ((await unlinkConfinedLeafIfIdentity(root, path.join(dir, candidate.name), dir, sameIdentity(candidate))) !== "unlinked") {
        throw new Error(`segment ${store}/${candidate.name} or its directory changed during the collection`);
      }
      entry.deletedLeaves += 1;
      entry.deletedBytes += Number(candidate.size);
      progress.deletedLeaves += 1;
      progress.deletedBytes += Number(candidate.size);
    }
  } finally {
    if (entry.deletedLeaves > 0) await fsyncConfinedDirectory(root, dir);
  }
}

/** Delete every store's candidates; any failure is `indexed_gc_partial` carrying what was deleted. */
async function deleteAll(root: string, stores: readonly StoreInventoryV1[]): Promise<GcDeletedV1> {
  const progress: Progress = { deletedLeaves: 0, deletedBytes: 0, stores: [] };
  try {
    for (const entry of stores) await deleteCandidates(root, entry.store, entry.candidates, progress);
  } catch (error) {
    const deleted = { ...progress, stores: progress.stores.filter((s) => s.deletedLeaves > 0) };
    throw new IndexedGcError("indexed_gc_partial", `${error instanceof Error ? error.message : String(error)}; ${deleted.deletedLeaves} unreferenced leaves (${deleted.deletedBytes} bytes) were deleted before it stopped, the logical stores are unchanged; preview again`, deleted);
  }
  return { ...progress, stores: progress.stores.filter((s) => s.deletedLeaves > 0) };
}

/** Options of an apply. */
export interface GcApplyOptions {
  /** The operator's assertion that no reader without a lease (an older build, another tool) is running. */
  readonly readersOffline?: boolean;
  /** Test-only seam between the reader census and the re-inventory, for registration/collection race coverage. */
  readonly afterCensusForTest?: () => Promise<void>;
}

/** The locked half of an apply over canonical `root`. */
async function collectLocked(root: string, plan: GcPlanV1, options: GcApplyOptions): Promise<GcApplyV1> {
  const census = await readerCensus(root);
  assertNoReaders(census);
  await options.afterCensusForTest?.();
  const inventory = await projectInventory(root);
  assertCurrent(plan, inventory);
  return { ...(await deleteAll(root, inventory.stores)), staleLeases: census.stale.length };
}

/** Apply a still-current plan. See the file comment for every refusal. */
export async function applyGc(root: string, planValue: unknown, options: GcApplyOptions = {}): Promise<GcApplyV1> {
  const plan = parseGcPlan(planValue);
  if (options.readersOffline !== true) {
    throw new IndexedGcError("indexed_gc_offline_unconfirmed", "assert readersOffline: no llmwiki process from a build without reader leases, and no other tool, may be reading .llmwiki/indexed; leases cannot reveal them");
  }
  const canonical = await canonicalRoot(root);
  return withMaintenanceLock(canonical, {}, () => collectLocked(canonical, plan, options));
}
