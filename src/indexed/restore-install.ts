/**
 * @file src/indexed/restore-install.ts
 * @description The effects of an indexed-authority restore. Each target
 * admits ONLY its journalled original state or its intended restored state;
 * anything else is `indexed_restore_conflict` and nothing more is changed.
 * Runs inside the restore's private scope, under the project lock and the
 * marker, after the reader census.
 *
 * JOURNAL. Before the FIRST effect, the original state of EVERY planned
 * target is recorded durably in the marker: each backed-up segment (absent,
 * or its digest), each auxiliary file (absent, or its digest) and each
 * manifest. A resumed restore parses the journal strictly against the
 * backup's exact membership and re-validates every target as original or
 * intended BEFORE any new effect; nothing is ever re-captured.
 *
 * STATE EQUALITY. A target's state is its CONTENT (absent, or its SHA-256):
 * a same-content file replaced under another inode is treated as the same
 * state. The one destructive unlink (restoring a recorded absence) is still
 * bound to the exact identity of the file whose content was just checked.
 *
 * FENCE. Every effect, and the last seam of every replacement, first proves
 * this restore still holds the marker (its exact token) and that the backup
 * directory is the one verified.
 *
 * MANIFESTS. The intended manifest is the backup's, with each bound legacy
 * file's stamp reconciled to the file actually installed (the only permitted
 * difference, reported).
 */

import path from "node:path";
import { captureLegacy } from "../history/contracts.js";
import { INDEXED_DIR, MAX_SEGMENT_BYTES, type SegmentManifest } from "../segments/contracts.js";
import { newCounters } from "../segments/counters.js";
import { diskSegmentStoreIo, readManifestLeaf } from "../segments/io.js";
import { serializeManifest } from "../segments/manifest.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { fsyncConfinedDirectory, unlinkConfinedLeafIfIdentity } from "../utils/confined-delete.js";
import { allowedAuxiliary, sha256Of } from "./backup-format.js";
import { IndexedRestoreError, intendedAux, readVerified, storeRel, type AuxStateV1, type VerifiedBackup } from "./restore-check.js";
import { currentAux, segmentState } from "./restore-target.js";

/** The restore's journal: every target's original and intended state, persisted in the marker. */
export interface RestoreJournalV1 {
  readonly scaleRecordSha256: string;
  readonly stores: { readonly store: string; readonly original: string | null; intended: string | null }[];
  readonly segments: { readonly store: string; readonly name: string; readonly original: string | null; readonly intended: string }[];
  readonly aux: { readonly relPath: string; readonly original: AuxStateV1; readonly intended: AuxStateV1 }[];
}

/** What installation did, for the receipt. */
export interface InstallReport { created: number; kept: number; repaired: number; auxWritten: string[]; auxRemoved: string[]; auxUntouched: string[]; reconciledStamps: string[] }

/** Everything one installation needs: where, what, and the ownership fence run before each effect. */
export interface InstallContext { readonly root: string; readonly backup: VerifiedBackup; readonly journal: RestoreJournalV1; readonly fence: () => Promise<void> }

/** Refuse: a target is neither its recorded original nor its intended state. */
function conflict(what: string): never {
  throw new IndexedRestoreError("indexed_restore_conflict", `${what} is neither its recorded original nor its intended state; nothing more was changed (inspect it, then re-run the same restore)`);
}

/** The read cap of `relPath` from the stores' allowlist. */
function auxCap(root: string, backup: VerifiedBackup, relPath: string): number {
  for (const [store, { manifest }] of backup.manifests) for (const aux of allowedAuxiliary(root, store, manifest).aux) if (aux.relPath === relPath) return aux.cap;
  return conflict(`auxiliary path ${relPath}`);
}

/** Whether two auxiliary states are the same. */
function sameAux(left: AuxStateV1, right: AuxStateV1): boolean {
  return left.state === right.state && (left.state === "absent" || left.sha256 === (right as { sha256: string }).sha256);
}

/** Record the original state of every planned target (call before the first effect). */
export async function captureOriginals(root: string, backup: VerifiedBackup, scaleRecordSha256: string): Promise<RestoreJournalV1> {
  const stores = [];
  for (const store of backup.manifests.keys()) {
    const read = await readManifestLeaf(root, store);
    stores.push({ store, original: read.kind === "ok" ? sha256Of(read.bytes) : null, intended: null });
  }
  const segments = [];
  for (const entry of backup.index.stores) for (const segment of entry.segments) segments.push({ store: entry.store, name: segment.name, original: await segmentState(root, entry.store, segment.name), intended: segment.sha256 });
  const aux = [];
  for (const entry of backup.index.auxiliary) aux.push({ relPath: entry.relPath, original: (await currentAux(root, entry.relPath, auxCap(root, backup, entry.relPath))).state, intended: intendedAux(entry) });
  return { scaleRecordSha256, stores, segments, aux };
}

/** Install one segment: keep when intended, create over recorded absence, or replace its recorded original. */
async function installSegment(ctx: InstallContext, entry: RestoreJournalV1["segments"][number], report: InstallReport): Promise<void> {
  const { root, backup, fence } = ctx;
  const current = await segmentState(root, entry.store, entry.name);
  if (current === entry.intended) { report.kept += 1; return; }
  if (current !== entry.original) conflict(`segment ${entry.store}/${entry.name}`);
  const listed = backup.index.stores.find((s) => s.store === entry.store)!.segments.find((s) => s.name === entry.name)!;
  const bytes = await readVerified(backup.dir, path.posix.join(storeRel(entry.store), entry.name), listed.bytes, listed.sha256, MAX_SEGMENT_BYTES);
  await fence();
  if (entry.original === null) { await diskSegmentStoreIo(root, entry.store).writeSegment(entry.name, bytes); report.created += 1; return; }
  const stillOriginal = async () => { await fence(); if ((await segmentState(root, entry.store, entry.name)) !== entry.original) conflict(`segment ${entry.store}/${entry.name}`); };
  await atomicWrite(path.join(root, INDEXED_DIR, entry.store, entry.name), bytes, { confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600, beforeReplace: stillOriginal });
  report.repaired += 1;
}

/** Move one auxiliary path from its recorded original to its intended state. */
async function installAux(ctx: InstallContext, entry: RestoreJournalV1["aux"][number], report: InstallReport): Promise<void> {
  const { root, backup, fence } = ctx;
  const cap = auxCap(root, backup, entry.relPath);
  const now = await currentAux(root, entry.relPath, cap);
  if (sameAux(now.state, entry.intended)) { report.auxUntouched.push(entry.relPath); return; }
  if (!sameAux(now.state, entry.original)) conflict(`auxiliary file ${entry.relPath}`);
  const leaf = path.join(root, entry.relPath);
  await fence();
  if (entry.intended.state === "present") {
    const listed = backup.index.auxiliary.find((aux) => aux.relPath === entry.relPath) as { bytes: number; sha256: string };
    const bytes = await readVerified(backup.dir, path.posix.join("tree", entry.relPath), listed.bytes, listed.sha256, cap);
    const stillOriginal = async () => { await fence(); if (!sameAux((await currentAux(root, entry.relPath, cap)).state, entry.original)) conflict(`auxiliary file ${entry.relPath}`); };
    await atomicWrite(leaf, bytes, { confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600, beforeReplace: stillOriginal });
    report.auxWritten.push(entry.relPath);
    return;
  }
  // Restoring an ABSENCE: the content-checked read and the unlink are bound to the same file identity.
  const identity = now.identity ?? conflict(`auxiliary file ${entry.relPath}`);
  if ((await unlinkConfinedLeafIfIdentity(root, leaf, path.dirname(leaf), identity)) !== "unlinked") conflict(`auxiliary file ${entry.relPath}`);
  await fsyncConfinedDirectory(root, path.dirname(leaf));
  report.auxRemoved.push(entry.relPath);
}

/** Install every segment and auxiliary file (phase `installing-files`). */
export async function installFiles(ctx: InstallContext): Promise<InstallReport> {
  const report: InstallReport = { created: 0, kept: 0, repaired: 0, auxWritten: [], auxRemoved: [], auxUntouched: [], reconciledStamps: [] };
  for (const entry of ctx.journal.segments) await installSegment(ctx, entry, report);
  for (const entry of ctx.journal.aux) await installAux(ctx, entry, report);
  return report;
}

/** The backup manifest of `store` with its bound legacy file's stamp reconciled to the installed file. */
async function intendedManifest(root: string, backup: VerifiedBackup, store: string, report: InstallReport): Promise<Buffer> {
  const { bytes, manifest } = backup.manifests.get(store)!;
  const legacy = manifest.meta.legacy as { relPath: string; sha256: string | null; stamp: unknown } | undefined;
  if (legacy === undefined) return bytes;
  const installed = await captureLegacy(root, legacy.relPath, auxCap(root, backup, legacy.relPath), newCounters());
  if (installed.snapshot.sha256 !== legacy.sha256) conflict(`legacy file ${legacy.relPath}`);
  if (JSON.stringify(installed.snapshot.stamp) === JSON.stringify(legacy.stamp)) return bytes;
  report.reconciledStamps.push(store);
  const next: SegmentManifest = { ...manifest, meta: { ...manifest.meta, legacy: { ...legacy, stamp: installed.snapshot.stamp } } };
  return serializeManifest(next);
}

/** Compute every intended manifest and record its digest in the journal (persisted by the caller before publication). */
export async function intendedManifests(ctx: InstallContext, report: InstallReport): Promise<Map<string, Buffer>> {
  const intended = new Map<string, Buffer>();
  for (const entry of ctx.journal.stores) {
    const bytes = await intendedManifest(ctx.root, ctx.backup, entry.store, report);
    if (entry.intended !== null && entry.intended !== sha256Of(bytes)) conflict(`intended manifest of ${entry.store}`);
    entry.intended = sha256Of(bytes);
    intended.set(entry.store, bytes);
  }
  return intended;
}

/** The current manifest digest of `store`, or null. */
async function manifestState(root: string, store: string): Promise<string | null> {
  const read = await readManifestLeaf(root, store);
  return read.kind === "ok" ? sha256Of(read.bytes) : null;
}

/** Publish each intended manifest over its recorded original (phase `installing-manifests`). */
export async function publishManifests(ctx: InstallContext, intended: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const entry of ctx.journal.stores) {
    const now = await manifestState(ctx.root, entry.store);
    if (now === entry.intended) continue;
    if (now !== entry.original) conflict(`manifest of ${entry.store}`);
    const stillOriginal = async () => { await ctx.fence(); if ((await manifestState(ctx.root, entry.store)) !== entry.original) conflict(`manifest of ${entry.store}`); };
    await ctx.fence();
    await diskSegmentStoreIo(ctx.root, entry.store).publishManifest(intended.get(entry.store)!, stillOriginal);
  }
}

/** Before any new effect of a RESUMED restore: every target must be its original or its intended state. */
export async function assertResumable(ctx: InstallContext): Promise<void> {
  const { root, backup, journal } = ctx;
  for (const entry of journal.segments) {
    const now = await segmentState(root, entry.store, entry.name);
    if (now !== entry.original && now !== entry.intended) conflict(`segment ${entry.store}/${entry.name}`);
  }
  for (const entry of journal.aux) {
    const now = (await currentAux(root, entry.relPath, auxCap(root, backup, entry.relPath))).state;
    if (!sameAux(now, entry.original) && !sameAux(now, entry.intended)) conflict(`auxiliary file ${entry.relPath}`);
  }
  for (const entry of journal.stores) {
    const now = await manifestState(root, entry.store);
    if (now !== entry.original && (entry.intended === null || now !== entry.intended)) conflict(`manifest of ${entry.store}`);
  }
}
