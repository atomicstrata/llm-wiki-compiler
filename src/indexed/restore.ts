/**
 * @file src/indexed/restore.ts
 * @description Restore the INDEXED AUTHORITY SET of a project from an
 * indexed-authority backup, to the SAME canonical root only. Not a wiki
 * restore: Markdown, config and custody are prerequisites the operator keeps.
 *
 * ORDER, with nothing changed before step 4:
 * 1. `readersOffline` must be asserted (readers of builds without leases are
 *    invisible); the backup is verified byte for byte (`./restore-check.ts`).
 * 2. Everything below runs in the restore's private scope
 *    (`../segments/restore-marker.ts`) under the maintenance acquisition
 *    (`./maintenance-lock.ts`): this process must not have read the stores,
 *    the raw project lock is taken, and every custody leg of the gate is
 *    checked read-only, the restored workspace catalogs from the verified
 *    backup (so a lost or corrupt one does not block its own repair).
 * 3. Under the project lock: the prerequisites are checked; a stale
 *    `preflight` marker (no effect can have begun) is removed; the marker is
 *    published (`preflight`), THEN the reader census runs (any live or
 *    uncertain lease refuses, and the no-effect marker is removed).
 * 4. The journal of original states is recorded (`installing-files`); files
 *    are installed; intended manifests are recorded (`installing-manifests`)
 *    and published; the full verifier runs inside the scope; the marker
 *    becomes `verified` and is removed.
 * A failure after step 4 begins leaves the marker: every read and write
 * refuses until the SAME restore is re-run, which resumes from the journal
 * (accepting only original or intended states). A marker that cannot be
 * removed after a verified restore is `indexed_restore_cleanup_failed`.
 */

import { randomBytes } from "node:crypto";
import { operationCatalogStore } from "../history/operation-catalog.js";
import { canonicalRoot, readerCensus } from "../segments/reader-lease.js";
import {
  holdsRestoreMarker, MAX_MARKER_BYTES, markerOwnerStale, readRestoreMarker, removeRestoreMarker, runWithRestoreAccess, writeRestoreMarker, type RestoreMarkerV1, type RestorePhase,
} from "../segments/restore-marker.js";
import { serializeOwner } from "../utils/lock-owner.js";
import { sha256Of } from "./backup-format.js";
import { INDEXED_BACKUP_EXCLUDES, scaleRecordBytes } from "./backup.js";
import { assertBackupUnchanged, assertPrerequisites, IndexedRestoreError, loadVerifiedBackup, RESTORE_MARKER_PATH, type VerifiedBackup } from "./restore-check.js";
import { assertResumable, captureOriginals, installFiles, intendedManifests, publishManifests, type InstallReport, type RestoreJournalV1 } from "./restore-install.js";
import { bindJournal } from "./restore-target.js";
import { withMaintenanceLock } from "./maintenance-lock.js";
import { verifyIndexedStores } from "./verify.js";

/** What a completed restore did. */
export interface IndexedRestoreReceiptV1 extends InstallReport {
  readonly scope: "indexed-authority";
  readonly backupDigest: string;
  readonly resumed: boolean;
  /** Stores whose manifest equals the backup's byte for byte (others differ only in a reconciled legacy stamp). */
  readonly byteIdenticalStores: readonly string[];
  readonly notIncluded: string;
}

/** How this invocation relates to a marker already present. */
type Start = { kind: "fresh" } | { kind: "stale-preflight"; marker: RestoreMarkerV1 } | { kind: "resume"; marker: RestoreMarkerV1 };

/** Decide from the marker on disk; anything but a stale, matching or no-effect marker refuses. */
async function startOf(root: string, backup: VerifiedBackup): Promise<Start> {
  const read = await readRestoreMarker(root);
  if (read.kind === "absent") return { kind: "fresh" };
  if (read.kind === "unreadable") throw new IndexedRestoreError("indexed_restore_conflict", "the restore marker cannot be read; inspect .llmwiki/indexed-restore.json by hand");
  const marker = read.marker;
  if (!markerOwnerStale(marker)) throw new IndexedRestoreError("indexed_restore_readers_active", "another restore holds the marker and its owner is running");
  if (marker.phase === "preflight" && marker.journal === null) return { kind: "stale-preflight", marker };
  if (marker.backupDigest !== backup.digest) throw new IndexedRestoreError("indexed_restore_conflict", "an interrupted restore of a DIFFERENT backup holds the marker; re-run that restore");
  return { kind: "resume", marker };
}

/** The journal a resumed marker carries, bound to this backup and re-checked against the current scale record. */
async function resumedJournal(root: string, marker: RestoreMarkerV1, backup: VerifiedBackup): Promise<RestoreJournalV1> {
  const journal = bindJournal(marker.journal, backup);
  if (sha256Of(await scaleRecordBytes(root)) !== journal.scaleRecordSha256) throw new IndexedRestoreError("indexed_restore_prerequisite", "the scale record changed since the interrupted restore began");
  return journal;
}

/** The fence run before every effect: this restore still holds the marker, and the backup is the one verified. */
function fenceOf(root: string, backup: VerifiedBackup): () => Promise<void> {
  return async () => {
    await assertBackupUnchanged(backup);
    if (!(await holdsRestoreMarker(root))) throw new IndexedRestoreError("indexed_restore_conflict", "this restore no longer holds the restore marker; nothing more was changed");
  };
}

/** Writes the marker for one restore token. */
function markerWriter(root: string, backup: VerifiedBackup, token: string) {
  return (phase: RestorePhase, journal: RestoreJournalV1 | null, create = false) => writeRestoreMarker(root, {
    format: "llmwiki-indexed-restore-marker", version: 1, token, backupDigest: backup.digest, phase, owner: JSON.parse(serializeOwner(process.pid)), journal,
  }, create ? null : token);
}

/**
 * The most segments a restore journal can record within the marker's cap
 * (each entry is at most about 200 bytes). A larger backup refuses BEFORE any
 * marker: this build's restore supports backups up to this size.
 */
const MAX_JOURNAL_SEGMENTS = Math.floor((MAX_MARKER_BYTES - 64 * 1024) / 200);

/** Refuse, before any marker, a backup whose journal could not fit the marker. */
function assertJournalFits(backup: VerifiedBackup): void {
  const segments = backup.index.stores.reduce((sum, s) => sum + s.segments.length, 0);
  if (segments > MAX_JOURNAL_SEGMENTS) throw new IndexedRestoreError("indexed_restore_prerequisite", `the backup lists ${segments} referenced segments; this build's restore journal records at most ${MAX_JOURNAL_SEGMENTS}, so this backup cannot be restored by this build`);
}

/** Publish a fresh marker, take the census, and record the original states; a no-effect failure removes its own marker. */
async function beginFresh(root: string, backup: VerifiedBackup, token: string): Promise<RestoreJournalV1> {
  assertJournalFits(backup);
  const write = markerWriter(root, backup, token);
  await write("preflight", null, true);
  try {
    const census = await readerCensus(root);
    const busy = [...census.live, ...census.uncertain];
    if (busy.length > 0) throw new IndexedRestoreError("indexed_restore_readers_active", `reader leases are live or cannot be classified: ${busy.slice(0, 5).join(", ")}; nothing was changed`);
    const journal = await captureOriginals(root, backup, sha256Of(await scaleRecordBytes(root)));
    await write("installing-files", journal);
    return journal;
  } catch (error) {
    await removeNoEffectMarker(root, token, error);
    throw error instanceof IndexedRestoreError ? error : new IndexedRestoreError("indexed_restore_prerequisite", `the restore could not begin, nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * After a failure before any effect: remove this restore's marker when it is
 * provably still this token in phase `preflight`; otherwise keep it and say so.
 */
async function removeNoEffectMarker(root: string, token: string, cause: unknown): Promise<void> {
  const read = await readRestoreMarker(root);
  const ours = read.kind === "ok" && read.marker.token === token && read.marker.phase === "preflight";
  try {
    if (ours) { await removeRestoreMarker(root, token); return; }
  } catch { /* fall through: the marker could not be removed */ }
  throw new IndexedRestoreError("indexed_restore_cleanup_failed", `the restore failed before any effect (${cause instanceof Error ? cause.message : String(cause)}) but its marker could not be proved and removed; inspect .llmwiki/indexed-restore.json`);
}

/**
 * An error raised AFTER installation began, as a restore error that says so:
 * authority may be partly restored, the marker stays, and the same restore
 * must be re-run. A no-effect refusal never passes through here.
 */
function afterEffects(error: unknown): IndexedRestoreError {
  if (error instanceof IndexedRestoreError && error.recoveryRequired) return error;
  const code = error instanceof IndexedRestoreError ? error.code : "indexed_restore_conflict";
  const detail = error instanceof Error ? error.message : String(error);
  return new IndexedRestoreError(code, `${detail}; installation had begun, so indexed authority may be partly restored: the marker ${RESTORE_MARKER_PATH} stays and every read refuses until the same \`llmwiki catalog restore\` is re-run`, true);
}

/** Install, publish, verify and clean up under one journal; any failure is reported as after-effects. */
async function install(root: string, backup: VerifiedBackup, token: string, journal: RestoreJournalV1, options: RestoreOptions, resumed: boolean): Promise<IndexedRestoreReceiptV1> {
  try {
    return await installBody(root, backup, token, journal, options, resumed);
  } catch (error) {
    throw afterEffects(error);
  }
}

/** The body of {@link install}. */
async function installBody(root: string, backup: VerifiedBackup, token: string, journal: RestoreJournalV1, options: RestoreOptions, resumed: boolean): Promise<IndexedRestoreReceiptV1> {
  const write = markerWriter(root, backup, token);
  const ctx = { root, backup, journal, fence: fenceOf(root, backup) };
  if (resumed) await assertResumable(ctx);
  const report = await installFiles(ctx);
  await options.afterInstallFilesForTest?.();
  const intended = await intendedManifests(ctx, report);
  await write("installing-manifests", journal);
  await publishManifests(ctx, intended);
  const verification = await verifyIndexedStores(root);
  if (!verification.ok) throw new IndexedRestoreError("indexed_restore_verify_failed", `${verification.storesFailed} store(s) failed verification after installation: ${verification.stores.filter((s) => !s.ok).map((s) => `${s.store}: ${s.problems.join("; ")}`).join(" | ")}`, true);
  await write("verified", journal);
  try { await removeRestoreMarker(root, token); } catch (error) {
    throw new IndexedRestoreError("indexed_restore_cleanup_failed", `the restore verified but its marker could not be removed (${error instanceof Error ? error.message : String(error)}); re-run the same restore`, true);
  }
  const byteIdenticalStores = journal.stores.filter((s) => s.intended === backup.index.stores.find((b) => b.store === s.store)?.manifestSha256).map((s) => s.store);
  return { scope: "indexed-authority", backupDigest: backup.digest, resumed, byteIdenticalStores, notIncluded: INDEXED_BACKUP_EXCLUDES, ...report };
}

/** The locked body of a restore, inside its private scope. */
async function restoreLocked(root: string, backup: VerifiedBackup, start: Start, token: string, options: RestoreOptions): Promise<IndexedRestoreReceiptV1> {
  await assertPrerequisites(root, backup);
  if (start.kind === "resume") {
    const census = await readerCensus(root);
    if (census.live.length + census.uncertain.length > 0) throw new IndexedRestoreError("indexed_restore_readers_active", "reader leases are live; nothing more was changed");
    return install(root, backup, token, await resumedJournal(root, start.marker, backup), options, true);
  }
  if (start.kind === "stale-preflight") await removeRestoreMarker(root, start.marker.token);
  return runWithRestoreAccess(root, token, async () => install(root, backup, token, await beginFresh(root, backup, token), options, false));
}

/** Options of a restore. */
export interface RestoreOptions {
  /** The operator's assertion that no reader without a lease (an older build, another tool) is running. */
  readonly readersOffline?: boolean;
  /** Test-only seam after files are installed and before manifests are published (crash and resume coverage). */
  readonly afterInstallFilesForTest?: () => Promise<void>;
}

/** Restore the indexed authority set of the project at `root` from the backup in `dir`. */
export async function restoreIndexedBackup(root: string, dir: string, options: RestoreOptions = {}): Promise<IndexedRestoreReceiptV1> {
  if (options.readersOffline !== true) throw new IndexedRestoreError("indexed_restore_offline_unconfirmed", "assert readersOffline: no llmwiki process from a build without reader leases, and no other tool, may be reading .llmwiki/indexed");
  const canonical = await canonicalRoot(root);
  const backup = await loadVerifiedBackup(canonical, dir);
  const start = await startOf(canonical, backup);
  const scopeToken = start.kind === "fresh" ? randomBytes(16).toString("hex") : start.marker.token;
  const token = start.kind === "resume" ? start.marker.token : start.kind === "fresh" ? scopeToken : randomBytes(16).toString("hex");
  const custody = { restoredCatalogs: restoredCatalogsOf(backup) };
  return runWithRestoreAccess(canonical, scopeToken, () => withMaintenanceLock(canonical, custody, () => restoreLocked(canonical, backup, start, token, options)));
}

/** The verified backup's manifest `meta` of each workspace catalog it restores: what the bundle leg reads for exactly those. */
function restoredCatalogsOf(backup: VerifiedBackup): Map<string, Readonly<Record<string, unknown>>> {
  const catalogs = new Map<string, Readonly<Record<string, unknown>>>();
  for (const workspace of backup.index.prerequisites.workspaces) {
    const entry = backup.manifests.get(operationCatalogStore(workspace));
    if (entry !== undefined) catalogs.set(workspace, entry.manifest.meta);
  }
  return catalogs;
}
