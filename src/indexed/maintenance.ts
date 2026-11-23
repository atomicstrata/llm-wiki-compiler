/**
 * @file src/indexed/maintenance.ts
 * @description The explicit MAINTENANCE entries of an active `local-indexed`
 * project, shared by the CLI (`llmwiki catalog gc|pin|unpin|pins`) and the SDK
 * (`wiki.catalog.gc`, `pin`, `unpin`, `pins`, `runs`): segment collection,
 * pinned snapshots, indexed-authority backup and restore, and explicit
 * retirement of finished batch compile runs (`./run-retire.ts`).
 *
 * Every entry refuses with `catalog_not_active` unless `local-indexed` is the
 * active architecture. A preview and the pin listing are read-only; pinning,
 * unpinning and applying a collection plan run under the project mutation
 * lock. An apply must run in a process that has not read the stores (the CLI
 * is one), and requires the operator's assertion that no reader from a build
 * without reader leases is running (`./gc.ts`).
 */

import { CatalogNotActiveError } from "../catalog/facade.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { withRegisteredProjectLock } from "../operation-bundles/registered-project-lock.js";
import { canonicalRoot } from "../segments/reader-lease.js";
import { releaseLock } from "../utils/lock.js";
import { createIndexedBackup, type IndexedBackupReceiptV1 } from "./backup.js";
import { applyGc, previewGc, type GcApplyV1, type GcPreviewV1 } from "./gc.js";
import { restoreIndexedBackup, type IndexedRestoreReceiptV1 } from "./restore.js";
import { applyRunRetirement, previewRunRetirement, type RunRetireApplyV1, type RunRetirePreviewV1 } from "./run-retire.js";
import { listStores } from "./gc-inventory.js";
import { createPin, readPins, removePin } from "./pins.js";
import { indexedActive } from "./routing.js";

/** The pins of a project, and why any cannot be trusted. */
export interface IndexedPinsV1 {
  readonly labels: readonly string[];
  readonly blockers: readonly string[];
}

/** The canonical root of an ACTIVE indexed project, or `catalog_not_active`. */
async function activeRoot(root: string): Promise<string> {
  if (!(await indexedActive(root))) throw new CatalogNotActiveError();
  return canonicalRoot(root);
}

/** Preview a segment collection (read-only). */
export async function catalogGcPreview(root: string): Promise<GcPreviewV1> {
  return previewGc(await activeRoot(root));
}

/** Apply a collection plan from {@link catalogGcPreview}, unchanged. */
export async function catalogGcApply(root: string, plan: unknown, options: { readonly readersOffline?: boolean } = {}): Promise<GcApplyV1> {
  return applyGc(await activeRoot(root), plan, options);
}

/** Pin every store's current manifest as `label`; returns how many stores were pinned. */
export async function catalogPin(root: string, label: string): Promise<{ readonly label: string; readonly stores: number }> {
  const canonical = await activeRoot(root);
  return withRegisteredProjectLock(canonical, async () => {
    const listed = await listStores(canonical);
    if (listed.blockers.length > 0) throw new Error(`cannot pin: ${listed.blockers.join("; ")}`);
    return { label, stores: await createPin(canonical, label, listed.stores) };
  });
}

/**
 * Remove pin `label`. Always under the ORDINARY gated project lock (never the
 * registration wrapper's unlocked branch, which a lost scale record would
 * select), and only after rechecking, under that lock, that this same
 * canonical root is still an active indexed project: activation can change
 * while the lock is awaited, and an interrupted pin's recovery deletes files.
 */
export async function catalogUnpin(root: string, label: string): Promise<{ readonly label: string }> {
  const canonical = await activeRoot(root);
  await acquireMutationLockBlocking(canonical, "ordinary");
  try {
    if (!(await indexedActive(canonical)) || (await canonicalRoot(canonical)) !== canonical) throw new CatalogNotActiveError();
    await removePin(canonical, label);
  } finally {
    await releaseLock(canonical);
  }
  return { label };
}

/** The project's pins, validated (read-only). */
export async function catalogPins(root: string): Promise<IndexedPinsV1> {
  const canonical = await activeRoot(root);
  const listed = await listStores(canonical);
  const pins = await readPins(canonical, new Set(listed.stores));
  return { labels: pins.labels, blockers: [...listed.blockers, ...pins.blockers] };
}

/** Back up the indexed authority set (not a wiki backup) into new or empty `dir`, outside the project. */
export async function catalogBackup(root: string, dir: string): Promise<IndexedBackupReceiptV1> {
  return createIndexedBackup(await activeRoot(root), dir);
}

/**
 * Restore the indexed authority set from the backup in `dir`, to the same
 * canonical root. Not gated on `indexedActive`: an interrupted restore's
 * marker makes routing refuse, and the restore's own prerequisites check the
 * exact scale record instead.
 */
export function catalogRestore(root: string, dir: string, options: { readonly readersOffline?: boolean } = {}): Promise<IndexedRestoreReceiptV1> {
  return restoreIndexedBackup(root, dir, options);
}

/** Preview a retirement of finished batch compile runs (read-only; superseded runs' evidence is read under a reader lease). */
export async function catalogRunsPreview(root: string, options: { readonly keepFinished?: number } = {}): Promise<RunRetirePreviewV1> {
  return previewRunRetirement(await activeRoot(root), options);
}

/** Retire exactly the runs a still-current plan from {@link catalogRunsPreview} names (from a process that has not read the stores). */
export async function catalogRunsRetire(root: string, plan: unknown, options: { readonly readersOffline?: boolean } = {}): Promise<RunRetireApplyV1> {
  return applyRunRetirement(await activeRoot(root), plan, options);
}
