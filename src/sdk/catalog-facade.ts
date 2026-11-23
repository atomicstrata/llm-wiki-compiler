/**
 * @file src/sdk/catalog-facade.ts
 * @description The SDK's `wiki.catalog` facade: the durable paged catalog of
 * a `local-indexed` project. Reads change no store authority, but every
 * indexed read registers this process's reader lease once
 * (`.llmwiki/indexed-readers`, see `segments/reader-lease.ts`). `status()` is bounded (manifest
 * counts and one stat per catalogued directory); `sync()` reconciles the catalog with the
 * files under the project lock, an explicit full walk. On any other project
 * `status()` reports `active: false` and `sync()` refuses with
 * `catalog_not_active`. Listings themselves stay on `wiki.listPages` and
 * `wiki.listSources`, which use the catalog automatically when it is active.
 */

import { catalogStatus, catalogSync, catalogVerify, type CatalogStatusV1, type CatalogSyncReportV1 } from "../catalog/facade.js";
import type { GcApplyV1, GcPreviewV1 } from "../indexed/gc.js";
import type { IndexedBackupReceiptV1 } from "../indexed/backup.js";
import { catalogBackup, catalogGcApply, catalogGcPreview, catalogPin, catalogPins, catalogRestore, catalogRunsPreview, catalogRunsRetire, catalogUnpin, type IndexedPinsV1 } from "../indexed/maintenance.js";
import type { IndexedRestoreReceiptV1 } from "../indexed/restore.js";
import type { RunRetireApplyV1, RunRetirePreviewV1 } from "../indexed/run-retire.js";
import type { IndexedVerificationV1 } from "../indexed/verify.js";

export type { CatalogStatusV1, CatalogSyncReportV1 } from "../catalog/facade.js";
export type { IndexedStorageV1, IndexedVerificationV1, StoreCheckV1 } from "../indexed/verify.js";
export type { StorageInventoryV1 } from "../segments/verify.js";
export type { GcApplyV1, GcDeletedV1, GcPlanStoreV1, GcPlanV1, GcPreviewV1, IndexedGcErrorCode } from "../indexed/gc.js";
export type { IndexedPinsV1 } from "../indexed/maintenance.js";
export type { IndexedBackupReceiptV1 } from "../indexed/backup.js";
export type { IndexedRestoreReceiptV1 } from "../indexed/restore.js";
export type { IndexedRestoreErrorCode } from "../indexed/restore-check.js";
export type { IndexedRunsErrorCode, RunRetireApplyV1, RunRetireDoneV1, RunRetiredV1, RunRetirePlanCandidateV1, RunRetirePlanCleanupV1, RunRetirePlanV1, RunRetirePreviewV1 } from "../indexed/run-retire.js";
export type { RunClassV1, RunEntryV1 } from "../indexed/run-retire-inventory.js";
export type { CatalogListingNote } from "../catalog/reads.js";
export type { CatalogCounts } from "../catalog/contracts.js";

/** `wiki.catalog`: the durable paged catalog of a `local-indexed` project. */
export interface WikiCatalogSurface {
  /** Counts and freshness; `active: false` when the project is not `local-indexed`. */
  status(): Promise<CatalogStatusV1>;
  /** Reconcile the catalog with the files (explicit full walk, under the project lock). */
  sync(): Promise<CatalogSyncReportV1>;
  /**
   * Fully verify every indexed store and its backup (explicit, O(stored
   * data)); health for this call only. It changes no store authority; like
   * every indexed read, it registers this process's reader lease.
   */
  verify(): Promise<IndexedVerificationV1>;
  /**
   * Segment collection. `preview()` is read-only and returns a plan;
   * `apply(plan, { readersOffline: true })` deletes exactly the unreferenced,
   * unpinned segments the still-current plan names. Apply refuses in a
   * process that has already read these stores (run it from a fresh one),
   * while any reader lease is live, and unless `readersOffline` asserts that
   * no reader from a build without leases (or another tool) is running. A
   * failure during deletion rejects with code `indexed_gc_partial` and a
   * `partial` count of what was deleted; every other refusal deleted nothing.
   */
  readonly gc: {
    preview(): Promise<GcPreviewV1>;
    apply(plan: unknown, options: { readonly readersOffline: boolean }): Promise<GcApplyV1>;
  };
  /** Pin every store's current manifest as `label`, so a collection keeps its segments. */
  pin(label: string): Promise<{ readonly label: string; readonly stores: number }>;
  /** Remove pin `label`. */
  unpin(label: string): Promise<{ readonly label: string }>;
  /** The pins, and any that cannot be trusted. */
  pins(): Promise<IndexedPinsV1>;
  /** Back up the INDEXED AUTHORITY SET only (not a wiki backup) into a new or empty directory outside the project. */
  backup(dir: string): Promise<IndexedBackupReceiptV1>;
  /**
   * Restore the indexed authority set from `dir`, to the same project root
   * only, from a process that has not read these stores. `readersOffline`
   * asserts that no reader from a build without leases is running. A failure
   * after installation began leaves a marker that makes every read refuse
   * until the same restore is re-run.
   */
  restore(dir: string, options: { readonly readersOffline: boolean }): Promise<IndexedRestoreReceiptV1>;
  /**
   * Explicit retirement of finished batch compile run stores. `preview()` is
   * read-only and returns a plan plus every run's class: finished runs other
   * than the compile state's last run, and superseded runs with no restart
   * publication evidence, beyond the newest `keepFinished` (default 10), may
   * go; pinned, active and evidence-carrying runs stay. A retired run's REPORT
   * is deleted with it (`reportsLost`; page it with `compileReport` first).
   * `retire(plan, { readersOffline: true })` retires exactly what the
   * still-current plan names. Call it from a process that has NOT read these
   * stores: the preview itself reads under a reader lease, so preview and
   * retire from separate processes. A failure after the reader census rejects
   * with code `indexed_runs_partial` and a `partial` account (runs count as
   * retired from their commit); `indexed_runs_cleanup_failed` follows a
   * COMPLETED retirement whose barrier could not be removed (its `partial` is
   * the full account); every other refusal retired nothing.
   */
  readonly runs: {
    preview(options?: { readonly keepFinished?: number }): Promise<RunRetirePreviewV1>;
    retire(plan: unknown, options: { readonly readersOffline: boolean }): Promise<RunRetireApplyV1>;
  };
}

/** Build `wiki.catalog` for the project at `root`, each call run through `run` (the SDK's quiet wrapper). */
export function buildCatalogFacade(root: string, run: <T>(fn: () => Promise<T>) => Promise<T>): WikiCatalogSurface {
  return {
    status: () => run(() => catalogStatus(root)), sync: () => run(() => catalogSync(root)), verify: () => run(() => catalogVerify(root)),
    gc: { preview: () => run(() => catalogGcPreview(root)), apply: (plan, options) => run(() => catalogGcApply(root, plan, options)) },
    pin: (label) => run(() => catalogPin(root, label)), unpin: (label) => run(() => catalogUnpin(root, label)), pins: () => run(() => catalogPins(root)),
    backup: (dir) => run(() => catalogBackup(root, dir)), restore: (dir, options) => run(() => catalogRestore(root, dir, options)),
    runs: { preview: (options) => run(() => catalogRunsPreview(root, options)), retire: (plan, options) => run(() => catalogRunsRetire(root, plan, options)) },
  };
}
