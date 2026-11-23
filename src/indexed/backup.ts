/**
 * @file src/indexed/backup.ts
 * @description Make an INDEXED-AUTHORITY BACKUP (`./backup-format.ts`): the
 * stores' manifests and referenced segments, the event head anchor, and the
 * legacy files each store binds. Not a wiki backup; the receipt says what is
 * not included.
 *
 * 1. The destination must be outside the project and new or empty.
 * 2. This process registers its reader lease first, so a collection refuses
 *    while the copy runs.
 * 3. Under the project mutation lock, one consistent cut is captured: every
 *    store's exact manifest bytes, each allowlisted auxiliary file's bytes (a
 *    legacy file must still match the digest its manifest binds), the scale
 *    record and the prerequisite identities.
 * 4. Every referenced segment is copied through the confined no-follow open
 *    and checked against its manifest SHA-256, into a project-shaped tree,
 *    with every write confined beneath the bound destination. The full
 *    verifier then runs over that tree: a cut that does not verify gets no
 *    index. `backup.json` is written LAST, durably, after re-checking the
 *    destination's identity; without it the directory is never restorable.
 * The authority set must hold the catalog, event, relation and vector stores.
 * Batch compile run stores (`crun-*`) are DERIVED and never copied; while a
 * run is active (or a run store's meta cannot be read) the backup refuses.
 */

import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { withRegisteredProjectLock } from "../operation-bundles/registered-project-lock.js";
import { MAX_SCALE_RECORD_BYTES, SCALE_RECORD_FILE } from "../scale/contracts.js";
import { diskSegmentStoreIo, readManifestLeaf } from "../segments/io.js";
import { parseManifest } from "../segments/manifest.js";
import { canonicalRoot, ensureReaderLease } from "../segments/reader-lease.js";
import { INDEXED_DIR, type SegmentManifest } from "../segments/contracts.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";
import {
  allowedAuxiliary, BACKUP_INDEX, prerequisitesOf, REQUIRED_STORES, serializeBackupIndex, sha256Of,
  type AllowedAux, type BackupAuxV1, type BackupStoreV1,
} from "./backup-format.js";
import { isRunStoreName } from "../compiler/batch/contracts.js";
import { CSTATE_CAPABILITY, CSTATE_STORE } from "../cstate/contracts.js";
import { capabilityStatus } from "../scale/capability-status.js";
import { anyRunActive } from "../compiler/batch/run-store.js";
import { listStores } from "./gc-inventory.js";
import { verifyIndexedStores } from "./verify.js";
import { unbackedWorkspaceAuthority } from "./workspace-authority.js";

/** What a backup is not, stated in every receipt. */
export const INDEXED_BACKUP_EXCLUDES = "Markdown pages and sources, project config, workspace custody files, receipts and journals are NOT included and are not checked: back them up by ordinary means";

/** What a backup wrote. */
export interface IndexedBackupReceiptV1 {
  readonly scope: "indexed-authority";
  readonly dir: string;
  readonly stores: number;
  readonly segments: number;
  readonly segmentBytes: number;
  readonly auxiliary: readonly { readonly relPath: string; readonly state: "present" | "absent" }[];
  readonly notIncluded: string;
}

/** One captured store and one captured auxiliary file. */
interface CapturedStore { readonly store: string; readonly bytes: Buffer; readonly manifest: SegmentManifest }
interface CapturedAux { readonly relPath: string; readonly body: Buffer | null }

/** Resolve and prepare the destination: outside the project, new or empty, private. */
async function prepareDestination(root: string, dir: string): Promise<Destination> {
  const dest = path.resolve(dir);
  const parent = await realpath(path.dirname(dest)).catch(() => null);
  if (parent === null) throw new Error(`the backup destination's parent ${path.dirname(dest)} does not exist`);
  const real = path.join(parent, path.basename(dest));
  if (real === root || real.startsWith(`${root}${path.sep}`)) throw new Error("the backup destination must be outside the project");
  const existing = await lstat(real).catch(() => null);
  if (existing === null) await mkdir(real, { mode: 0o700 });
  else if (!existing.isDirectory() || (await readdir(real)).length > 0) throw new Error(`the backup destination ${real} must be a new or empty directory`);
  const bound = await lstat(real);
  return { dir: real, dev: bound.dev, ino: bound.ino };
}

/** The bytes of an allowlisted auxiliary file, or null when absent; anything unusable refuses. */
async function readAux(root: string, aux: AllowedAux, remaining: number): Promise<Buffer | null> {
  const leaf = path.join(root, aux.relPath);
  // Capped by its kind AND by what the cut may still hold, so the read itself never allocates past the aggregate cap.
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), Math.min(aux.cap, remaining));
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new Error(`${aux.relPath} is not a confined regular file within its cap; it cannot be backed up`);
  return read.body;
}

/** Refuse when a store's legacy file no longer matches the digest its manifest binds. */
function assertLegacyCurrent(manifest: SegmentManifest, relPath: string, body: Buffer | null): void {
  const legacy = manifest.meta.legacy as { relPath?: unknown; sha256?: unknown } | undefined;
  if (legacy?.relPath !== relPath) return;
  const now = body === null ? null : sha256Of(body);
  if (now !== legacy.sha256) throw new Error(`${relPath} no longer matches the legacy backup its store binds; run \`llmwiki catalog verify\``);
}

/** The scale record's exact bytes, required. */
export async function scaleRecordBytes(root: string): Promise<Buffer> {
  const leaf = path.join(root, SCALE_RECORD_FILE);
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_SCALE_RECORD_BYTES);
  if (read.kind !== "ok") throw new Error(`${SCALE_RECORD_FILE} cannot be read; an indexed-authority backup needs it`);
  return read.body;
}

/**
 * The most bytes one cut holds in memory (every manifest and bound auxiliary
 * file, before they are written out). A larger authority set refuses.
 */
const MAX_CUT_RESIDENT_BYTES = 1024 * 1024 * 1024;

/** Refuse once the cut would hold more than {@link MAX_CUT_RESIDENT_BYTES}. */
function chargeResident(held: { bytes: number }, more: number): void {
  held.bytes += more;
  if (held.bytes > MAX_CUT_RESIDENT_BYTES) throw new Error(`cannot back up: the manifests and bound files of this authority set exceed ${MAX_CUT_RESIDENT_BYTES} bytes held at once`);
}

/** The stores of the authority set: every store but the derived batch compile run stores, refusing while a run is active. */
async function authorityStores(root: string): Promise<{ stores: string[]; blockers: string[] }> {
  const listed = await listStores(root);
  if (await anyRunActive(root)) throw new Error("cannot back up: a batch compile run is active; finish it (llmwiki compile) or supersede it (llmwiki compile --restart) first");
  return { stores: listed.stores.filter((store) => !isRunStoreName(store)), blockers: listed.blockers };
}

/** Refuse a cut that omits the segmented compile state the project's scale record says is its authority. */
async function assertCompileStateListed(root: string, stores: readonly string[]): Promise<void> {
  if (stores.includes(CSTATE_STORE) || (await capabilityStatus(root, CSTATE_CAPABILITY)) === "absent") return;
  throw new Error(`cannot back up: the scale record holds the ${CSTATE_CAPABILITY} capability but the ${CSTATE_STORE} store is missing; the compile state is part of the authority`);
}

/** Capture one store's exact manifest bytes and its bound auxiliary files (appended to `aux`), charging what is held. */
async function captureStore(root: string, store: string, held: { bytes: number }, aux: CapturedAux[]): Promise<{ store: CapturedStore; workspace?: string }> {
  const read = await readManifestLeaf(root, store);
  if (read.kind !== "ok") throw new Error(`store ${store} has no manifest; it cannot be backed up`);
  chargeResident(held, read.bytes.byteLength);
  const manifest = parseManifest(read.bytes, store);
  const allowed = allowedAuxiliary(root, store, manifest);
  for (const entry of allowed.aux) {
    chargeResident(held, 0);
    const body = await readAux(root, entry, MAX_CUT_RESIDENT_BYTES - held.bytes);
    chargeResident(held, body?.byteLength ?? 0);
    assertLegacyCurrent(manifest, entry.relPath, body);
    aux.push({ relPath: entry.relPath, body });
  }
  return { store: { store, bytes: read.bytes, manifest }, ...(allowed.workspace === undefined ? {} : { workspace: allowed.workspace }) };
}

/** Capture one consistent cut under the lock. */
async function captureCut(root: string) {
  const listed = await authorityStores(root);
  if (listed.blockers.length > 0) throw new Error(`cannot back up: ${listed.blockers.join("; ")}`);
  const missing = REQUIRED_STORES.filter((store) => !listed.stores.includes(store));
  if (missing.length > 0) throw new Error(`cannot back up: the indexed authority is missing store(s) ${missing.join(", ")}`);
  await assertCompileStateListed(root, listed.stores);
  const stores: CapturedStore[] = [];
  const aux: CapturedAux[] = [];
  const workspaces: string[] = [];
  const held = { bytes: 0 };
  for (const store of listed.stores) {
    const captured = await captureStore(root, store, held, aux);
    if (captured.workspace !== undefined) workspaces.push(captured.workspace);
    stores.push(captured.store);
  }
  // Authority the copy would omit (an unimported workspace catalog) makes the backup incomplete: refuse before any index.
  const omitted = await unbackedWorkspaceAuthority(root, listed.stores, workspaces);
  if (omitted.length > 0) throw new Error(`cannot back up: ${omitted.join("; ")}`);
  return { stores, aux, prerequisites: await prerequisitesOf(root, await scaleRecordBytes(root), workspaces) };
}

/** The destination's identity, bound once it is prepared and checked before the index is written. */
interface Destination { readonly dir: string; readonly dev: number; readonly ino: number }

/** Refuse unless the destination is still the directory this backup prepared. */
async function assertDestination(dest: Destination): Promise<void> {
  const now = await lstat(dest.dir).catch(() => null);
  if (now === null || !now.isDirectory() || now.dev !== dest.dev || now.ino !== dest.ino) throw new Error(`the backup destination ${dest.dir} was replaced while the backup ran; it is not a usable backup`);
}

/** Write one new file at `rel` beneath the destination, confined to it (parents created confined), durably. */
async function writeNew(dest: Destination, rel: string, bytes: Buffer): Promise<void> {
  await ensureConfinedDirectory(dest.dir, path.dirname(rel));
  await atomicWrite(path.join(dest.dir, rel), bytes, { confineRoot: dest.dir, exactParent: true, createOnly: true, mode: 0o600 });
}

/** The tree-relative path of `rel` inside the backup. */
const inTree = (rel: string): string => path.posix.join("tree", rel);

/** Copy one store's manifest and every referenced segment (each checked against its digest). */
async function copyStore(root: string, dest: Destination, captured: CapturedStore): Promise<BackupStoreV1 & { bytes: number }> {
  const storeRel = inTree(path.posix.join(INDEXED_DIR, captured.store));
  await writeNew(dest, path.posix.join(storeRel, "manifest.json"), captured.bytes);
  const io = diskSegmentStoreIo(root, captured.store);
  const segments: BackupStoreV1["segments"][number][] = [];
  let bytes = 0;
  for (const run of captured.manifest.runs) for (const entry of run.segments) {
    const handle = await io.openSegment(entry.name);
    const whole = await handle.readAt(0, entry.bytes).finally(() => handle.close());
    if (handle.size !== entry.bytes || sha256Of(whole) !== entry.sha256) throw new Error(`segment ${captured.store}/${entry.name} does not match its manifest digest; it was not backed up`);
    await writeNew(dest, path.posix.join(storeRel, entry.name), whole);
    segments.push({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 });
    bytes += entry.bytes;
  }
  return { store: captured.store, manifestSha256: sha256Of(captured.bytes), segments, bytes };
}

/** Write the present auxiliary files at their own paths in the tree, and each workspace's directory; returns the index entries. */
async function copyAux(dest: Destination, aux: readonly CapturedAux[], workspaces: readonly string[]): Promise<BackupAuxV1[]> {
  for (const workspace of workspaces) await ensureConfinedDirectory(dest.dir, inTree(path.posix.join(".llmwiki", "workspaces", workspace)));
  const entries: BackupAuxV1[] = [];
  for (const item of aux) {
    if (item.body === null) { entries.push({ relPath: item.relPath, state: "absent" }); continue; }
    await writeNew(dest, inTree(item.relPath), item.body);
    entries.push({ relPath: item.relPath, state: "present", bytes: item.body.byteLength, sha256: sha256Of(item.body) });
  }
  return entries;
}

/**
 * Refuse unless the captured cut is HEALTHY: the full verifier over the
 * backup's own project-shaped tree (a copy of exactly the captured
 * manifests, segments and bound files). A backup of authority that does not
 * verify is not a usable recovery and gets no index.
 */
async function assertCutVerifies(dest: Destination, stores: readonly string[]): Promise<void> {
  const report = await verifyIndexedStores(path.join(dest.dir, "tree"), { archivedStores: new Set(stores) });
  if (!report.ok) throw new Error(`the captured indexed authority does not verify (${report.stores.filter((s) => !s.ok).map((s) => `${s.store}: ${s.problems.join("; ")}`).join(" | ")}); no backup index was written`);
}

/** Back up the indexed authority set of the project at `root` into new or empty `dir`. */
export async function createIndexedBackup(root: string, dir: string): Promise<IndexedBackupReceiptV1> {
  const canonical = await canonicalRoot(root);
  const dest = await prepareDestination(canonical, dir);
  await ensureReaderLease(canonical, true);
  const cut = await withRegisteredProjectLock(canonical, () => captureCut(canonical));
  const stores = [];
  for (const captured of cut.stores) stores.push(await copyStore(canonical, dest, captured));
  const auxiliary = await copyAux(dest, cut.aux, cut.prerequisites.workspaces);
  await assertCutVerifies(dest, stores.map((entry) => entry.store));
  const index = { createdAt: new Date().toISOString(), prerequisites: cut.prerequisites, stores: stores.map(({ bytes: _bytes, ...entry }) => entry), auxiliary };
  await assertDestination(dest);
  await atomicWrite(path.join(dest.dir, BACKUP_INDEX), serializeBackupIndex(index), { confineRoot: dest.dir, exactParent: true, createOnly: true, mode: 0o600 });
  return {
    scope: "indexed-authority", dir: dest.dir, stores: stores.length, segments: stores.reduce((sum, s) => sum + s.segments.length, 0),
    segmentBytes: stores.reduce((sum, s) => sum + s.bytes, 0), auxiliary: auxiliary.map(({ relPath, state }) => ({ relPath, state })), notIncluded: INDEXED_BACKUP_EXCLUDES,
  };
}
