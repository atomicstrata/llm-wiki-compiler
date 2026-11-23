/**
 * @file src/indexed/maintenance-lock.ts
 * @description THE MAINTENANCE ACQUISITION of a segment collector (indexed
 * GC apply, indexed restore): the raw project lock plus a READ-ONLY copy of
 * every custody leg of the shared recovery gate (`../operation-bundles/lock-gate.ts`).
 *
 * WHY NOT THE GATED LOCK. The gated acquisition writes (it recovers the page
 * journal and settles preparation handoffs), and its bundle leg reads every
 * workspace's segmented operation catalog, which registers a reader lease in
 * this process, after which the collector must refuse (`asCollector`). A
 * restore exists precisely when such a catalog may be lost or corrupt, so the
 * gate would also refuse the one operation that repairs it.
 *
 * ORDER:
 * 1. the collector preconditions (`assertCollectable`);
 * 2. the RAW project lock;
 * 3. under it, in the lease-free locked-metadata scope (`runWithLockedMetadataReads`),
 *    each leg refuses rather than settles: a page journal that is not `ok`
 *    (`journalHealth`); an operation bundle needing recovery
 *    (`detectBundleRecoveryFrom`, with, for a restore only, the verified
 *    backup's summary for exactly the workspace catalogs it restores, every
 *    other custody read from the target); an unresolved portable intent; the
 *    scale gate; unfinished preparation lifecycle maintenance; and a
 *    preparation settlement the gate's pass would perform
 *    (`pendingPreparationSettlement`); then, for a batch run retirement only,
 *    its own read-only inventory in the same scope (`lockedCheck`);
 * 4. the collector preconditions again (a read of this process may have
 *    registered meanwhile), then the body as the collection (`asCollector`);
 * 5. the lock is released on every exit.
 * A leg's refusal is `indexed_maintenance_blocked`, naming the leg; nothing
 * was changed.
 */

import { catalogSummary, catalogSummaryOfMeta, type CatalogSummary } from "../history/operation-catalog-read.js";
import { diskOperationInventoryReads, scanOperationInventoryFrom } from "../operation-bundles/capacity.js";
import { detectBundleRecoveryFrom, diskLifecycleGateReads, diskOperationRecoveryReads, gatePreparationLifecycleFrom } from "../operation-bundles/lock-gate.js";
import { portableGateBlock, PortableRecoveryBlockingError } from "../portable/host/pending-gate.js";
import { pendingPreparationSettlement } from "../preparations/settlement-pending.js";
import { scaleGateRefusal } from "../scale/gate.js";
import { readScaleRecord } from "../scale/record.js";
import { asCollector, assertCollectable, runWithLockedMetadataReads } from "../segments/reader-lease.js";
import { journalHealth } from "../trust/journal-health.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { indexedActive } from "./routing.js";

/** The custody leg that refused a maintenance acquisition. */
export type MaintenanceLeg = "page-journal" | "operation-bundles" | "portable" | "scale" | "preparation-lifecycle" | "preparation-settlement";

/** A maintenance acquisition refused by one custody leg; nothing was changed. */
export class IndexedMaintenanceBlockedError extends Error {
  constructor(readonly leg: MaintenanceLeg, detail: string, readonly code: "indexed_maintenance_blocked" = "indexed_maintenance_blocked") {
    super(`indexed_maintenance_blocked: ${leg}: ${detail}; settle it with an ordinary llmwiki command first, then re-run this one`);
    this.name = "IndexedMaintenanceBlockedError";
  }
}

/** What a maintenance acquisition is told about the authority it will replace. */
export interface MaintenanceCustodyOptions {
  /** RESTORE ONLY: the verified backup's manifest `meta` of each workspace catalog it restores, by workspace. */
  readonly restoredCatalogs?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /**
   * RUN RETIREMENT ONLY: one more read-only check in the SAME locked, lease-free
   * scope, after every custody leg. It resolves to nothing; by its caller's
   * discipline (not a type guarantee) it carries out only plain metadata it
   * validated, never a snapshot or iterator, which must not outlive the scope.
   */
  readonly lockedCheck?: () => Promise<void>;
  /**
   * SCALE-DOWN RESUME ONLY: the scale-down whose OWN fence (a `downgrade`
   * pending naming `plan`) the scale leg accepts, and the workspace catalog
   * record counts its plan froze. The fence admits no catalog write, so the
   * bundle leg reads those counts instead of the routed stores (which refuse
   * under the fence). Any other fence still refuses.
   */
  readonly downgradeFence?: { readonly plan: string; readonly catalogs: ReadonlyMap<string, number> };
}

/** The bundle leg's catalog summary of one workspace: a restored catalog from its verified backup, any other from the target. */
function catalogSummaryFor(root: string, options: MaintenanceCustodyOptions) {
  return async (workspaceId: string): Promise<CatalogSummary | null> => {
    const restored = options.restoredCatalogs?.get(workspaceId);
    if (restored !== undefined) return catalogSummaryOfMeta(restored, root, workspaceId);
    if (options.downgradeFence !== undefined) {
      const records = options.downgradeFence.catalogs.get(workspaceId);
      return records === undefined ? null : { status: "ok", records };
    }
    return (await indexedActive(root)) ? catalogSummary(root, workspaceId) : null;
  };
}

/** The bundle-recovery leg over the incumbent reads, with only the catalog summary rebound. */
async function bundleBlock(root: string, options: MaintenanceCustodyOptions): Promise<string | null> {
  const inventoryReads = { ...diskOperationInventoryReads(root), readCatalogSummary: catalogSummaryFor(root, options) };
  return detectBundleRecoveryFrom({ ...diskOperationRecoveryReads(root), scanInventory: () => scanOperationInventoryFrom(inventoryReads) });
}

/** Run one leg, turning its refusal (a block or a thrown incumbent refusal) into the typed maintenance refusal. */
async function leg(name: MaintenanceLeg, check: () => Promise<string | null>): Promise<void> {
  let block: string | null;
  try { block = await check(); } catch (error) { block = error instanceof Error ? error.message : String(error); }
  if (block !== null) throw new IndexedMaintenanceBlockedError(name, block);
}

/** The scale leg: the gate's refusal, except a resuming scale-down's own fence. */
async function scaleBlock(root: string, options: MaintenanceCustodyOptions): Promise<string | null> {
  const refusal = await scaleGateRefusal(root);
  if (refusal === null) return null;
  const plan = options.downgradeFence?.plan;
  if (refusal.block === "scale-downgrade-pending" && plan !== undefined) {
    const read = await readScaleRecord(root);
    if (read.kind === "ok" && read.record.pending?.kind === "downgrade" && read.record.pending.plan === plan) return null;
  }
  return refusal.message;
}

/** Every custody leg, read-only, in the gate's order. */
async function detectCustody(root: string, options: MaintenanceCustodyOptions): Promise<void> {
  await leg("page-journal", async () => { const { status } = await journalHealth(root); return status === "ok" ? null : `the page journal is ${status}`; });
  await leg("operation-bundles", () => bundleBlock(root, options));
  await leg("portable", async () => { const block = await portableGateBlock(root); return block === null ? null : new PortableRecoveryBlockingError(block).message; });
  await leg("scale", () => scaleBlock(root, options));
  await leg("preparation-lifecycle", async () => { await gatePreparationLifecycleFrom(diskLifecycleGateReads(root), "ordinary", undefined); return null; });
  await leg("preparation-settlement", async () => { const run = await pendingPreparationSettlement(root); return run === null ? null : `preparation run ${run} has a settlement owed`; });
}

/**
 * Run `body` as the collection of canonical `root` under the maintenance
 * acquisition (see the file comment for the order and every refusal).
 */
export async function withMaintenanceLock<T>(root: string, options: MaintenanceCustodyOptions, body: () => Promise<T>): Promise<T> {
  assertCollectable(root);
  await acquireLockBlocking(root);
  try {
    await runWithLockedMetadataReads(root, async () => { await detectCustody(root, options); await options.lockedCheck?.(); });
    assertCollectable(root);
    return await asCollector(root, body);
  } finally {
    await releaseLock(root);
  }
}
