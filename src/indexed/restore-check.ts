/**
 * @file src/indexed/restore-check.ts
 * @description The checking half of an indexed-authority restore: load a
 * backup and verify EVERY byte of it, then its tree semantically, and check
 * the prerequisite identities against the target project. It changes no
 * authority anywhere. Its one write is coordination metadata: the full
 * verifier registers this process's reader lease INSIDE the backup's tree
 * (`tree/.llmwiki/indexed-readers`), so a backup must sit on writable media
 * (read-only backup media is unsupported: recorded P3 debt).
 *
 * Every backup read is confined beneath the backup directory (no-follow,
 * single-link), whose identity is bound at load and re-checked before effects.
 * A backup is accepted only when `backup.json` parses strictly; every store's
 * manifest file matches its digest, parses, and lists exactly the segments
 * the index names; every segment and auxiliary file is a regular single-link
 * file of the recorded size and SHA-256; and the auxiliary paths are exactly
 * the allowlist of the stores' recognised kinds (`./backup-format.ts`); the
 * required stores are present; and the backup's own project-shaped tree
 * passes the FULL verifier, so known-invalid input never reaches a marker.
 *
 * Prerequisites (same canonical root only, never rebound): the root digest,
 * the scale record's exact bytes, the effective profile digest, each backed-up
 * workspace's directory, no target store the backup does not hold, and no
 * target workspace holding operation-catalog authority the backup lacks.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { INDEXED_DIR, MAX_SEGMENT_MANIFEST_BYTES, MAX_SEGMENT_BYTES, type SegmentManifest } from "../segments/contracts.js";
import { parseManifest } from "../segments/manifest.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import {
  allowedAuxiliary, BACKUP_INDEX, parseBackupIndex, prerequisitesOf, REQUIRED_STORES, sha256Of, type BackupAuxV1, type IndexedBackupV1,
} from "./backup-format.js";
import { scaleRecordBytes } from "./backup.js";
import { isRunStoreName } from "../compiler/batch/contracts.js";
import { CSTATE_CAPABILITY, CSTATE_STORE } from "../cstate/contracts.js";
import { capabilityStatus } from "../scale/capability-status.js";
import { anyRunActiveUnleased } from "../compiler/batch/run-store.js";
import { listStores } from "./gc-inventory.js";
import { unbackedWorkspaceAuthority } from "./workspace-authority.js";
import { verifyIndexedStores } from "./verify.js";

/** The backup index is small: one entry per store and segment. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** A verified backup: its index, digest and every store's parsed manifest. */
export interface VerifiedBackup {
  /** The canonical backup directory, and its identity bound at load. */
  readonly dir: string;
  readonly identity: { readonly dev: number; readonly ino: number };
  readonly index: IndexedBackupV1;
  readonly digest: string;
  readonly manifests: ReadonlyMap<string, { readonly bytes: Buffer; readonly manifest: SegmentManifest }>;
}

/** A typed restore refusal. Nothing was changed unless the code says so. */
export class IndexedRestoreError extends Error {
  /**
   * Set when the restore stopped AFTER installation began: indexed authority
   * may already be partly restored, the marker stays at {@link RESTORE_MARKER_PATH}
   * and every read refuses until the SAME restore is re-run.
   */
  readonly recoveryRequired: boolean;

  constructor(readonly code: IndexedRestoreErrorCode, message: string, recoveryRequired = false) {
    super(`${code}: ${message}`);
    this.name = "IndexedRestoreError";
    this.recoveryRequired = recoveryRequired;
  }
}

/** Where an interrupted restore's marker lives, relative to the project root. */
export const RESTORE_MARKER_PATH = ".llmwiki/indexed-restore.json";

/**
 * Why a restore stopped. `indexed_restore_invalid_backup`, `_prerequisite`,
 * `_offline_unconfirmed` and `_readers_active` changed nothing. `_conflict`,
 * `_verify_failed` and `_cleanup_failed` happened after installation began:
 * the marker stays and every read refuses until the same restore is re-run.
 */
export type IndexedRestoreErrorCode =
  | "indexed_restore_offline_unconfirmed" | "indexed_restore_invalid_backup" | "indexed_restore_prerequisite" | "indexed_restore_readers_active"
  | "indexed_restore_conflict" | "indexed_restore_verify_failed" | "indexed_restore_cleanup_failed";

/** Read one backup file `rel` (relative to the bound backup directory) confined, no-follow and single-link, within `cap`; or refuse. */
async function readBackupFile(dir: string, rel: string, cap: number): Promise<Buffer> {
  const leaf = path.join(dir, rel);
  const read = await readConfinedLeafBuffer(dir, leaf, path.dirname(leaf), cap, { requireSingleLink: true });
  if (read.kind !== "ok") throw new IndexedRestoreError("indexed_restore_invalid_backup", `${rel} is missing, not a confined regular single-link file, or larger than ${cap} bytes`);
  return read.body;
}

/** Read and check one backup file against its recorded size and digest. */
export async function readVerified(dir: string, rel: string, bytes: number, sha256: string, cap: number): Promise<Buffer> {
  const body = await readBackupFile(dir, rel, cap);
  if (body.byteLength !== bytes || sha256Of(body) !== sha256) throw new IndexedRestoreError("indexed_restore_invalid_backup", `${rel} does not match its recorded size and SHA-256`);
  return body;
}

/** The backup-relative directory of `store`. */
export const storeRel = (store: string): string => path.posix.join("tree", INDEXED_DIR, store);

/** Verify one store of the backup completely; returns its parsed manifest. */
async function verifyStore(dir: string, entry: IndexedBackupV1["stores"][number]): Promise<{ bytes: Buffer; manifest: SegmentManifest }> {
  const bytes = await readBackupFile(dir, path.posix.join(storeRel(entry.store), "manifest.json"), MAX_SEGMENT_MANIFEST_BYTES);
  if (sha256Of(bytes) !== entry.manifestSha256) throw new IndexedRestoreError("indexed_restore_invalid_backup", `store ${entry.store}'s manifest does not match its digest`);
  const manifest = parseManifest(bytes, entry.store);
  const listed = manifest.runs.flatMap((run) => run.segments.map((s) => `${s.name}:${s.bytes}:${s.sha256}`)).sort().join();
  if (listed !== entry.segments.map((s) => `${s.name}:${s.bytes}:${s.sha256}`).sort().join()) throw new IndexedRestoreError("indexed_restore_invalid_backup", `store ${entry.store}'s segments disagree with its manifest`);
  for (const segment of entry.segments) await readVerified(dir, path.posix.join(storeRel(entry.store), segment.name), segment.bytes, segment.sha256, MAX_SEGMENT_BYTES);
  return { bytes, manifest };
}

/** Refuse unless the backup's auxiliary paths are exactly its stores' allowlist, each present file verified. */
async function verifyAuxiliary(root: string, dir: string, index: IndexedBackupV1, manifests: VerifiedBackup["manifests"]): Promise<void> {
  const allowed = [...manifests].flatMap(([store, { manifest }]) => allowedAuxiliary(root, store, manifest).aux.map((aux) => aux.relPath)).sort();
  if (allowed.join() !== index.auxiliary.map((aux) => aux.relPath).sort().join()) throw new IndexedRestoreError("indexed_restore_invalid_backup", "the auxiliary files are not exactly those the backed-up stores allow");
  for (const aux of index.auxiliary) if (aux.state === "present") await readVerified(dir, path.posix.join("tree", aux.relPath), aux.bytes, aux.sha256, MAX_BINARY_STORE_BYTES);
}

/** Refuse unless the backup's own project-shaped tree passes the full verifier (known-invalid input never reaches a marker). */
async function verifyTree(dir: string, stores: ReadonlySet<string>): Promise<void> {
  const tree = path.join(dir, "tree");
  const stat = await lstat(tree).catch(() => null);
  // The tree must be a real directory inside the bound backup: never follow a swapped link (the lease would land outside the archive).
  if (stat === null || !stat.isDirectory() || (await realpath(tree).catch(() => null)) !== tree) throw new IndexedRestoreError("indexed_restore_invalid_backup", "the backup's tree is not a confined directory");
  const report = await verifyIndexedStores(tree, { archivedStores: stores });
  if (!report.ok) throw new IndexedRestoreError("indexed_restore_invalid_backup", `the backed-up authority does not verify: ${report.stores.filter((s) => !s.ok).map((s) => `${s.store}: ${s.problems.join("; ")}`).join(" | ")}`);
}

/** The bound identity of the backup directory. */
async function backupIdentity(dir: string): Promise<{ dir: string; dev: number; ino: number }> {
  const real = await realpath(dir).catch(() => null);
  const stat = real === null ? null : await lstat(real).catch(() => null);
  if (real === null || stat === null || !stat.isDirectory()) throw new IndexedRestoreError("indexed_restore_invalid_backup", `${dir} is not a backup directory`);
  return { dir: real, dev: stat.dev, ino: stat.ino };
}

/** Refuse unless the backup directory is still the one this restore verified. */
export async function assertBackupUnchanged(backup: VerifiedBackup): Promise<void> {
  const now = await lstat(backup.dir).catch(() => null);
  if (now === null || now.dev !== backup.identity.dev || now.ino !== backup.identity.ino) throw new IndexedRestoreError("indexed_restore_invalid_backup", "the backup directory was replaced during the restore");
}

/** Load the backup in `dir` and verify every byte of it, then its tree semantically, for the project at canonical `root`. */
export async function loadVerifiedBackup(root: string, dir: string): Promise<VerifiedBackup> {
  const identity = await backupIdentity(dir);
  const indexBytes = await readBackupFile(identity.dir, BACKUP_INDEX, MAX_INDEX_BYTES);
  let index: IndexedBackupV1;
  try { index = parseBackupIndex(indexBytes); } catch (error) { throw new IndexedRestoreError("indexed_restore_invalid_backup", error instanceof Error ? error.message : String(error)); }
  const manifests = new Map<string, { bytes: Buffer; manifest: SegmentManifest }>();
  try {
    for (const entry of index.stores) manifests.set(entry.store, await verifyStore(identity.dir, entry));
    await verifyAuxiliary(root, identity.dir, index, manifests);
    for (const store of REQUIRED_STORES) if (!manifests.has(store)) throw new IndexedRestoreError("indexed_restore_invalid_backup", `the backup lacks the required ${store} store`);
    await verifyTree(identity.dir, new Set(index.stores.map((entry) => entry.store)));
  } catch (error) {
    if (error instanceof IndexedRestoreError) throw error;
    throw new IndexedRestoreError("indexed_restore_invalid_backup", error instanceof Error ? error.message : String(error));
  }
  return { dir: identity.dir, identity, index, digest: sha256Of(indexBytes), manifests };
}

/** What about the target's stores keeps the backup from restoring it completely (each as a reason). */
async function targetStoreMismatches(root: string, backup: VerifiedBackup): Promise<string[]> {
  const mismatch: string[] = [];
  const listed = await listStores(root);
  // A finished batch compile run store is derived state the restore keeps; an active run refuses (read without a lease: the restore is the collector).
  if (await anyRunActiveUnleased(root)) mismatch.push("a batch compile run is active (finish it or supersede it with compile --restart first)");
  // The target's scale record makes the segmented compile state authority: a backup without it would restore an incomplete authority.
  if (!backup.manifests.has(CSTATE_STORE) && (await capabilityStatus(root, CSTATE_CAPABILITY)) !== "absent") mismatch.push(`the target holds the ${CSTATE_CAPABILITY} capability but the backup has no ${CSTATE_STORE} store`);
  for (const store of listed.stores) if (!backup.manifests.has(store) && !isRunStoreName(store)) mismatch.push(`target store ${store} is not in the backup (restore never deletes it)`);
  mismatch.push(...listed.blockers, ...await unbackedWorkspaceAuthority(root, listed.stores, backup.index.prerequisites.workspaces));
  return mismatch;
}

/** Refuse unless the target project at canonical `root` has exactly the backup's prerequisite identities. */
export async function assertPrerequisites(root: string, backup: VerifiedBackup): Promise<void> {
  const expected = backup.index.prerequisites;
  const scale = await scaleRecordBytes(root).catch(() => null);
  if (scale === null) throw new IndexedRestoreError("indexed_restore_prerequisite", "the target has no readable scale record");
  const now = await prerequisitesOf(root, scale, expected.workspaces);
  const mismatch = [
    now.rootDigest !== expected.rootDigest ? "a different project root (restore is to the same canonical root only)" : null,
    now.scaleRecordSha256 !== expected.scaleRecordSha256 ? "a different scale record" : null,
    now.profileDigest !== expected.profileDigest ? "a different effective profile" : null,
  ].filter((reason): reason is string => reason !== null);
  for (const workspace of expected.workspaces) {
    const stat = await lstat(path.join(root, ".llmwiki", "workspaces", workspace)).catch(() => null);
    if (stat === null || !stat.isDirectory()) mismatch.push(`workspace ${workspace} has no directory`);
  }
  mismatch.push(...await targetStoreMismatches(root, backup));
  if (mismatch.length > 0) throw new IndexedRestoreError("indexed_restore_prerequisite", mismatch.join("; "));
}

/** The state of one auxiliary path: absent, or present with its digest. */
export type AuxStateV1 = { readonly state: "absent" } | { readonly state: "present"; readonly sha256: string };

/** The intended state of a backup auxiliary entry. */
export function intendedAux(aux: BackupAuxV1): AuxStateV1 {
  return aux.state === "absent" ? { state: "absent" } : { state: "present", sha256: aux.sha256 };
}
