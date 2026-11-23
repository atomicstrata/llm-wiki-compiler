/**
 * @file src/indexed/run-retire-quarantine.ts
 * @description The EFFECTS of a batch run retirement (`./run-retire.ts`): how
 * one run store leaves `.llmwiki/indexed`, and how an interrupted removal is
 * finished. Runs under the maintenance lock, the retirement barrier and a
 * clean reader census.
 *
 * ONE STORE, IN ORDER:
 * 1. its leaves are listed again and must be exactly the inventoried set: the
 *    manifest and segment-named regular single-link files, bound by their
 *    exact identity (name, size, device, inode, nanosecond mtime);
 * 2. a durable CLEANUP RECEIPT `.llmwiki/indexed-retiring/<store>.receipt.json`
 *    (create-only, size-checked before it is written) records the canonical
 *    project root's digest, why the run was eligible, its manifest digest, its
 *    directory's identity and every leaf's identity (no name twice): positive
 *    proof of what this build owns in quarantine, valid only in this project;
 * 3. COMMIT: the store directory is renamed into `.llmwiki/indexed-retiring/`
 *    and both parents are synced. From here the run is retired: run discovery,
 *    backup, restore, GC and pins no longer see it;
 * 4. each leaf is unlinked only while it is still its recorded identity, the
 *    empty directory is removed, then the receipt.
 *
 * RECOVERY. A receipt is retained until its cleanup completes, so every
 * interrupted state is recognisable: the store still in place with its recorded
 * directory identity (never moved: only the receipt goes), in quarantine with
 * that identity and only recorded leaves (finished), or gone (only the receipt
 * goes). Anything else in quarantine (a directory without a receipt, a receipt
 * of another project root, one that disagrees with the disk, an unknown name)
 * is UNOWNED: it blocks the retirement, and neither it nor its receipt is ever
 * deleted. Nothing is removed recursively.
 *
 * INTERRUPTED RECEIPT. The create-only receipt writer can stop between its W
 * (`.writing`), R (`.tmp`) and F names (`../utils/publication-group.ts`), and
 * the store is moved only after F settles. A group with an alias is owned only
 * when it is exactly one writer state of exactly one store (a serial
 * retirement leaves at most one), its bytes are exactly what this build writes
 * for THIS project (strict UTF-8, closed schema, writer order), the store is
 * still at its recorded directory identity with exactly its recorded leaves and
 * manifest, and the quarantine destination is positively absent. It is planned
 * as an `unmoved` cleanup bound to those exact bytes, and finished, after the
 * plan, barrier and census, by an identity-bound discard of the receipt names
 * only. Nothing is moved on its authority and nothing is promoted: a store a
 * fresh plan retires gets a new receipt. A moved or absent store, a changed
 * store, foreign bytes or several groups at once block, with nothing touched.
 */

import { createHash } from "node:crypto";
import { chmod, lstat, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { isRunStoreName } from "../compiler/batch/contracts.js";
import { INDEXED_DIR, MANIFEST_LEAF, MAX_SEGMENT_MANIFEST_BYTES } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { SEGMENT_NAME_PATTERN } from "../segments/manifest.js";
import { readStampedLeaf, sameStamp, type LeafStamp } from "../segments/retire-barrier.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { fsyncConfinedDirectory, rmdirConfinedDurable, unlinkConfinedLeafIfIdentity } from "../utils/confined-delete.js";
import { listConfinedDirBounded, type ConfinedDirEntry } from "../utils/confined-dir.js";
import { resolveExpectedReal } from "../utils/confined-read.js";
import { discardProvenPublication, observePublicationGroup, publicationAliasesMayExist, type PublicationState } from "../utils/publication-group.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";
import { LLMWIKI_DIR } from "../utils/constants.js";
import { sameIdentity } from "./gc.js";
import { candidateDigest, identityOf, storeDirectory, MAX_STORES, type CandidateIdentityV1 } from "./gc-inventory.js";

/** The quarantine directory, relative to the project root (outside `.llmwiki/indexed`). */
export const RETIRING_DIR = ".llmwiki/indexed-retiring";
const RECEIPT_FORMAT = "llmwiki-run-retirement-receipt";
const RECEIPT_SUFFIX = ".receipt.json";
/** Most leaves one retired store may hold, so its receipt stays small. */
export const MAX_RETIRE_LEAVES = 20_000;
/** A receipt's read cap: every leaf identity fits well inside it. */
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** The create-only writer's reserved siblings of a receipt (scratch, then ready). */
const RECEIPT_ALIAS_SUFFIXES = [".writing", ".tmp"] as const;

/** Why a run may be retired. */
export type RunEligibilityV1 = "done-not-last-run" | "superseded-without-evidence";

/** A store's leaves, bound by identity. */
export interface StoreLeavesV1 { readonly identities: readonly CandidateIdentityV1[]; readonly digest: string; readonly bytes: number }

/** A store directory's identity. */
interface DirIdentity { readonly dev: string; readonly ino: string }

/** The durable cleanup receipt of one store. */
interface CleanupReceiptV1 {
  readonly format: typeof RECEIPT_FORMAT;
  readonly version: 1;
  readonly token: string;
  /** SHA-256 of the canonical project root: a receipt copied into another project authorizes nothing there. */
  readonly rootDigest: string;
  readonly store: string;
  readonly eligibility: RunEligibilityV1;
  readonly manifestSha256: string;
  readonly dir: DirIdentity;
  readonly leaves: readonly CandidateIdentityV1[];
}

/** Where an owned interrupted cleanup stands. */
export type PendingPhaseV1 = "unmoved" | "moved" | "removed";

/** An owned interrupted cleanup, bound by its receipt's exact bytes. */
export interface PendingCleanupV1 { readonly store: string; readonly receiptSha256: string; readonly phase: PendingPhaseV1 }

/** What the next store step may observe (test-only fault seam). */
export type RetireStepForTest = (step: "receipt" | "commit" | "leaf", store: string) => Promise<void>;

/** What a retirement learns as it goes: the commit of a store, and the bytes each unlink actually reclaimed. */
export interface RetireProgress { committed(store: string): void; reclaimed(bytes: number): void }

/** The digest a receipt binds its canonical project root by. */
const rootDigestOf = (root: string): string => createHash("sha256").update(root).digest("hex");

/** The lexical path of `relPath` under canonical `root`. */
const at = (root: string, relPath: string): string => path.join(root, relPath);

/**
 * The leaves of the store directory `relDir`: only the manifest and
 * segment-named regular single-link files, at most {@link MAX_RETIRE_LEAVES};
 * anything else is a reason string (the store is never removed then).
 */
export async function storeLeaves(root: string, relDir: string, dir: string): Promise<StoreLeavesV1 | string> {
  const listing = await listConfinedDirBounded(root, relDir, MAX_RETIRE_LEAVES);
  if (listing.kind !== "ok") return `${relDir} cannot be listed in full (unreadable, or more than ${MAX_RETIRE_LEAVES} leaves)`;
  const identities: CandidateIdentityV1[] = [];
  for (const { name, kind } of listing.entries) {
    if (kind !== "file" || (name !== MANIFEST_LEAF && !SEGMENT_NAME_PATTERN.test(name))) return `${relDir} holds ${name.slice(0, 80)}, which a retirement never deletes`;
    const identity = await identityOf(dir, name);
    if (typeof identity === "string") return `${relDir}: ${identity}`;
    identities.push(identity);
  }
  return { identities, digest: candidateDigest(identities), bytes: identities.reduce((sum, leaf) => sum + Number(leaf.size), 0) };
}

/** The identity of the real, confined directory at `relDir`, or `null` when absent; a redirected or non-directory entry throws. */
async function dirIdentity(root: string, relDir: string): Promise<DirIdentity | null> {
  const stat = await lstat(at(root, relDir), { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat === null) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${relDir} is not a real directory`);
  if ((await realpath(at(root, relDir))) !== (await resolveExpectedReal(root, at(root, relDir)))) throw new Error(`${relDir} is redirected`);
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** Whether `value` is one strictly shaped leaf identity. */
function isIdentity(value: unknown): value is CandidateIdentityV1 {
  const record = value as Record<string, unknown>;
  const closed = value !== null && typeof value === "object" && Object.keys(record).sort().join() === "dev,ino,mtimeNs,name,size";
  return closed && typeof record.name === "string" && (record.name === MANIFEST_LEAF || SEGMENT_NAME_PATTERN.test(record.name)) && ["size", "dev", "ino", "mtimeNs"].every((key) => /^\d{1,24}$/.test(String(record[key])) && typeof record[key] === "string");
}

/** A receipt's exact keys, sorted and comma-joined. */
const RECEIPT_KEYS = "dir,eligibility,format,leaves,manifestSha256,rootDigest,store,token,version";
/** A decimal identity field (device, inode). */
const DECIMAL = /^\d{1,24}$/;

/** Whether `value` is a closed receipt object of this format and version, for `store`. */
function hasReceiptShape(value: unknown, store: string): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join() === RECEIPT_KEYS && record.format === RECEIPT_FORMAT && record.version === 1 && record.store === store;
}

/** Whether a receipt's token, digests and eligibility are well formed. */
function receiptFieldsValid(record: Record<string, unknown>): boolean {
  const digests = /^[0-9a-f]{32}$/.test(String(record.token)) && /^[0-9a-f]{64}$/.test(String(record.manifestSha256)) && /^[0-9a-f]{64}$/.test(String(record.rootDigest));
  return digests && ["done-not-last-run", "superseded-without-evidence"].includes(record.eligibility as string);
}

/** Whether a receipt's directory identity is well formed. */
function receiptDirValid(dir: unknown): boolean {
  if (dir === null || typeof dir !== "object") return false;
  const record = dir as Record<string, unknown>;
  return Object.keys(record).sort().join() === "dev,ino" && DECIMAL.test(String(record.dev)) && DECIMAL.test(String(record.ino));
}

/** Whether a receipt's leaves are a bounded list of strict identities with no name twice. */
function receiptLeavesValid(leaves: unknown): boolean {
  return Array.isArray(leaves) && leaves.length <= MAX_RETIRE_LEAVES && leaves.every(isIdentity) && distinctNames(leaves as CandidateIdentityV1[]);
}

/** Whether `value` is a closed-shape receipt this build wrote for `store` (any root; the caller checks the root). */
function isReceipt(value: unknown, store: string): value is CleanupReceiptV1 {
  return hasReceiptShape(value, store) && receiptFieldsValid(value) && receiptDirValid(value.dir) && receiptLeavesValid(value.leaves);
}

/** Whether no leaf name appears twice. */
const distinctNames = (leaves: readonly CandidateIdentityV1[]): boolean => new Set(leaves.map((leaf) => leaf.name)).size === leaves.length;

/** A receipt with its exact bytes' digest and the identity of the leaf it was read from. */
interface ReceiptRead { readonly receipt: CleanupReceiptV1; readonly stamp: LeafStamp; readonly sha256: string }

/** The receipt of `store`, or a reason string. */
async function readReceipt(root: string, store: string): Promise<ReceiptRead | string> {
  const read = await readStampedLeaf(root, path.posix.join(RETIRING_DIR, `${store}${RECEIPT_SUFFIX}`), MAX_RECEIPT_BYTES);
  if (read.kind !== "ok") return `the cleanup receipt of ${store} cannot be read`;
  let value: unknown;
  try { value = JSON.parse(read.body.toString("utf8")); } catch { return `the cleanup receipt of ${store} is not JSON`; }
  if (!isReceipt(value, store)) return `the cleanup receipt of ${store} is malformed`;
  if (value.rootDigest !== rootDigestOf(root)) return `the cleanup receipt of ${store} belongs to another project root (a copy); it authorizes nothing here`;
  return { receipt: value, stamp: read.stamp, sha256: sha256Hex(read.body) };
}

/** Whether the store directory `dir` now holds only leaves its receipt recorded, each still that exact file. */
async function onlyRecordedLeaves(root: string, store: string, receipt: CleanupReceiptV1): Promise<boolean> {
  const relDir = path.posix.join(RETIRING_DIR, store);
  const leaves = await storeLeaves(root, relDir, at(root, relDir));
  if (typeof leaves === "string") return false;
  const recorded = new Set(receipt.leaves.map((leaf) => JSON.stringify(leaf)));
  return leaves.identities.every((leaf) => recorded.has(JSON.stringify(leaf)));
}

/** Where the store of an owned receipt stands, or a reason it is not owned. */
async function pendingPhase(root: string, store: string, receipt: CleanupReceiptV1): Promise<PendingPhaseV1 | string> {
  const sameDir = (found: DirIdentity | null) => found !== null && found.dev === receipt.dir.dev && found.ino === receipt.dir.ino;
  const source = await dirIdentity(root, path.posix.join(INDEXED_DIR, store));
  const target = await dirIdentity(root, path.posix.join(RETIRING_DIR, store));
  if (target === null) return source === null ? "removed" : sameDir(source) ? "unmoved" : `${store} was replaced since its cleanup receipt was written`;
  if (source !== null || !sameDir(target) || !(await onlyRecordedLeaves(root, store, receipt))) return `the quarantined ${store} does not match its cleanup receipt`;
  return "moved";
}

/** The store a quarantine file name belongs to (its receipt, or one of that receipt's reserved siblings), or null. */
function receiptNameOf(name: string): { readonly store: string; readonly alias: boolean } | null {
  for (const suffix of ["", ...RECEIPT_ALIAS_SUFFIXES]) {
    const tail = `${RECEIPT_SUFFIX}${suffix}`;
    if (name.endsWith(tail)) return { store: name.slice(0, -tail.length), alias: suffix !== "" };
  }
  return null;
}

/** The stem of a quarantine entry: a receipt's (or receipt alias's) store, a directory's name, or "" for anything else. */
function entryStem({ name, kind }: ConfinedDirEntry): string {
  if (kind === "file") return receiptNameOf(name)?.store ?? "";
  return kind === "directory" ? name : "";
}

/** A blocker for each quarantine entry no cleanup receipt owns (never deleted). */
function unownedEntries(entries: readonly ConfinedDirEntry[], receipts: ReadonlySet<string>): string[] {
  const owned = (entry: ConfinedDirEntry): boolean => { const stem = entryStem(entry); return isRunStoreName(stem) && receipts.has(stem); };
  return entries.filter((entry) => !owned(entry)).map(({ name }) => `unowned entry ${name.slice(0, 80)} in ${RETIRING_DIR} (no matching cleanup receipt); inspect it by hand, nothing deletes it`);
}

/** The owned interrupted cleanup of `store`, or the blocker its receipt or current state implies. */
async function pendingOf(root: string, store: string): Promise<PendingCleanupV1 | string> {
  const read = await readReceipt(root, store);
  if (typeof read === "string") return read;
  const phase = await pendingPhase(root, store, read.receipt);
  return phase === "unmoved" || phase === "moved" || phase === "removed" ? { store, receiptSha256: read.sha256, phase } : phase;
}

/** The stores with a receipt name, and those with a reserved receipt alias, among quarantine `entries`. */
function receiptStores(entries: readonly ConfinedDirEntry[]): { readonly receipts: Set<string>; readonly aliased: Set<string> } {
  const named = entries.filter((entry) => entry.kind === "file").map((entry) => receiptNameOf(entry.name)).filter((found) => found !== null && isRunStoreName(found.store));
  return { receipts: new Set(named.map((found) => found!.store)), aliased: new Set(named.filter((found) => found!.alias).map((found) => found!.store)) };
}

/** The owned interrupted cleanups in quarantine, and a blocker for anything unowned (never deleted). */
export async function quarantineInventory(root: string): Promise<{ pending: PendingCleanupV1[]; blockers: string[] }> {
  // One extra name: a serial retirement can leave one receipt as W+R.
  const listing = await listConfinedDirBounded(root, RETIRING_DIR, 2 * MAX_STORES + 1);
  if (listing.kind === "absent") return { pending: [], blockers: [] };
  if (listing.kind !== "ok") return { pending: [], blockers: [`${RETIRING_DIR} cannot be listed in full`] };
  const pending: PendingCleanupV1[] = [];
  const { receipts, aliased } = receiptStores(listing.entries);
  const blockers = unownedEntries(listing.entries, receipts);
  if (aliased.size > 1) blockers.push(`${aliased.size} interrupted cleanup receipts (${[...aliased].sort().join(", ")}); a serial retirement leaves at most one, so none is owned; inspect them by hand`);
  for (const store of [...receipts].sort()) {
    if (aliased.has(store) && aliased.size > 1) continue;
    const found = aliased.has(store) ? await interruptedReceiptOf(root, store) : await pendingOf(root, store);
    if (typeof found === "string") blockers.push(found); else pending.push(found);
  }
  return { pending, blockers };
}

/**
 * Whether a receipt's scalar fields are actual strings, as the writer emits them. `isReceipt` tests their
 * spelling through `String(...)`, so a one-element array would pass it and reserialize unchanged (REC-1);
 * only the interrupted-receipt proof requires the types, leaving settled-F replay's policy as it was.
 */
function hasWriterScalars(receipt: CleanupReceiptV1): boolean {
  return [receipt.token, receipt.rootDigest, receipt.manifestSha256, receipt.dir.dev, receipt.dir.ino].every((field) => typeof field === "string");
}

/** The receipt `body` of `store` holds when its ORIGINAL bytes are exactly what this build writes for this project, or a reason. */
function canonicalReceipt(root: string, store: string, body: Buffer): CleanupReceiptV1 | string {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)); } catch { return `the interrupted cleanup receipt of ${store} is not strict UTF-8 JSON`; }
  if (!isReceipt(value, store) || !hasWriterScalars(value) || value.rootDigest !== rootDigestOf(root)) return `the interrupted cleanup receipt of ${store} is not one this build wrote for this project`;
  const { format, version, token, rootDigest, eligibility, manifestSha256, dir, leaves } = value;
  const writer = { format, version, token, rootDigest, store, eligibility, manifestSha256, dir: { dev: dir.dev, ino: dir.ino }, leaves: leaves.map(({ name, size, dev, ino, mtimeNs }) => ({ name, size, dev, ino, mtimeNs })) };
  return body.equals(Buffer.from(`${JSON.stringify(writer)}\n`, "utf8")) ? value : `the interrupted cleanup receipt of ${store} is not byte for byte what this build writes`;
}

/** Whether two leaf lists hold exactly the same identities (any order). */
function sameLeaves(a: readonly CandidateIdentityV1[], b: readonly CandidateIdentityV1[]): boolean {
  const keyed = (leaves: readonly CandidateIdentityV1[]) => leaves.map((leaf) => JSON.stringify([leaf.name, leaf.size, leaf.dev, leaf.ino, leaf.mtimeNs])).sort().join("\n");
  return a.length === b.length && keyed(a) === keyed(b);
}

/** Whether directory identity `source` is present and exactly the one `receipt` recorded. */
function isReceiptedDirectory(source: DirIdentity | null, receipt: CleanupReceiptV1): boolean {
  return source !== null && source.dev === receipt.dir.dev && source.ino === receipt.dir.ino;
}

/** Null when the quarantine destination is absent and the store is still the receipted directory; else the reason. Only the two identity reads are inside the try. */
async function placementProblem(root: string, store: string, sourceRel: string, receipt: CleanupReceiptV1): Promise<string | null> {
  try {
    if ((await dirIdentity(root, path.posix.join(RETIRING_DIR, store))) !== null) return `${RETIRING_DIR}/${store} exists beside an interrupted cleanup receipt; inspect it by hand`;
    if (!isReceiptedDirectory(await dirIdentity(root, sourceRel), receipt)) return `run store ${store} is not the directory its interrupted cleanup receipt names`;
  } catch (error) { return `run store ${store} cannot be checked against its interrupted cleanup receipt: ${error instanceof Error ? error.message : String(error)}`; }
  return null;
}

/** Null when the store still holds exactly the receipted leaves; else the reason. */
async function leavesProblem(root: string, store: string, sourceRel: string, receipt: CleanupReceiptV1): Promise<string | null> {
  const leaves = await storeLeaves(root, sourceRel, at(root, sourceRel));
  return typeof leaves === "string" || !sameLeaves(leaves.identities, receipt.leaves) ? `run store ${store} changed since its interrupted cleanup receipt was written` : null;
}

/** Null when the store's manifest is the receipted one; else the reason. */
async function manifestProblem(root: string, store: string, sourceRel: string, receipt: CleanupReceiptV1): Promise<string | null> {
  const manifest = await readStampedLeaf(root, path.posix.join(sourceRel, MANIFEST_LEAF), MAX_SEGMENT_MANIFEST_BYTES);
  return manifest.kind === "ok" && sha256Hex(manifest.body) === receipt.manifestSha256 ? null : `the manifest of run store ${store} is not the one its interrupted cleanup receipt names`;
}

/** Null when `store` is still exactly what `receipt` recorded (in place, same leaves and manifest) and its quarantine destination is absent; else the reason. Checks run in this order and stop at the first reason. */
async function storeStillReceipted(root: string, store: string, receipt: CleanupReceiptV1): Promise<string | null> {
  const sourceRel = path.posix.join(INDEXED_DIR, store);
  return (await placementProblem(root, store, sourceRel, receipt)) ?? (await leavesProblem(root, store, sourceRel, receipt)) ?? (await manifestProblem(root, store, sourceRel, receipt));
}

/** The exact proof that `store`'s interrupted receipt is an owned unmoved cleanup (see INTERRUPTED RECEIPT), or the reason. Read-only. */
async function proveInterruptedReceipt(root: string, store: string): Promise<{ readonly sha256: string; readonly state: PublicationState } | string> {
  const observed = await observePublicationGroup(at(root, path.posix.join(RETIRING_DIR, `${store}${RECEIPT_SUFFIX}`)), root, MAX_RECEIPT_BYTES);
  if (observed.kind !== "group" || observed.state === "F") return `the interrupted cleanup receipt of ${store} is no state its writer leaves (${observed.kind === "refused" ? observed.reason : observed.kind}); inspect it by hand`;
  const receipt = canonicalReceipt(root, store, observed.body);
  if (typeof receipt === "string") return receipt;
  return (await storeStillReceipted(root, store, receipt)) ?? { sha256: sha256Hex(observed.body), state: observed.state };
}

/** The owned unmoved cleanup an interrupted receipt of `store` is, or the blocker it implies. Read-only. */
async function interruptedReceiptOf(root: string, store: string): Promise<PendingCleanupV1 | string> {
  const proof = await proveInterruptedReceipt(root, store);
  return typeof proof === "string" ? proof : { store, receiptSha256: proof.sha256, phase: "unmoved" };
}

/** Re-prove the planned interrupted receipt under the lock, then discard only its names through the held, identity-bound discard. */
async function discardInterruptedReceipt(root: string, pending: PendingCleanupV1): Promise<void> {
  const proof = await proveInterruptedReceipt(root, pending.store);
  if (typeof proof === "string" || proof.sha256 !== pending.receiptSha256) throw new Error(`the interrupted cleanup receipt of ${pending.store} changed since the plan${typeof proof === "string" ? ` (${proof})` : ""}`);
  const final = at(root, path.posix.join(RETIRING_DIR, `${pending.store}${RECEIPT_SUFFIX}`));
  await discardProvenPublication(final, root, MAX_RECEIPT_BYTES, (state, body) => state === proof.state && sha256Hex(body) === pending.receiptSha256);
}

/** Durably remove `store`'s receipt, only while it is still the exact leaf whose digest `sha256` was checked. */
async function removeReceipt(root: string, store: string, sha256: string): Promise<void> {
  const read = await readReceipt(root, store);
  if (typeof read === "string" || read.sha256 !== sha256) throw new Error(`the cleanup receipt of ${store} changed; nothing was removed`);
  const leaf = at(root, path.posix.join(RETIRING_DIR, `${store}${RECEIPT_SUFFIX}`));
  if ((await unlinkConfinedLeafIfIdentity(root, leaf, path.dirname(leaf), (now) => sameStamp(read.stamp, now))) !== "unlinked") throw new Error(`the cleanup receipt of ${store} changed while it was being removed`);
  await fsyncConfinedDirectory(root, path.dirname(leaf));
}

/** Unlink every recorded leaf of quarantined `store` still present as its exact identity, then remove the empty directory. */
async function removeQuarantined(root: string, store: string, leaves: readonly CandidateIdentityV1[], progress: RetireProgress, step?: RetireStepForTest): Promise<void> {
  const dir = at(root, path.posix.join(RETIRING_DIR, store));
  for (const leaf of leaves) {
    const outcome = await unlinkConfinedLeafIfIdentity(root, path.join(dir, leaf.name), dir, sameIdentity(leaf));
    if (outcome === "unlinked") progress.reclaimed(Number(leaf.size));
    // A recorded leaf already gone was removed by an earlier, interrupted cleanup; one still present but different is not ours.
    else if (await lstat(path.join(dir, leaf.name)).then(() => true, () => false)) throw new Error(`quarantined ${store}/${leaf.name} changed; nothing more was removed`);
    await step?.("leaf", store);
  }
  await fsyncConfinedDirectory(root, dir);
  await rmdirConfinedDurable(root, dir, at(root, RETIRING_DIR));
}

/** Sync both rename parents before deleting leaves, even when a retry can already see the move. */
async function syncRetirementParents(root: string): Promise<void> {
  await fsyncConfinedDirectory(root, at(root, INDEXED_DIR));
  await fsyncConfinedDirectory(root, at(root, RETIRING_DIR));
}

/**
 * Finish one owned interrupted cleanup, re-checked against its receipt first:
 * the current state must be exactly the planned one, or nothing (the receipt
 * included) is touched.
 */
export async function finishCleanup(root: string, pending: PendingCleanupV1, progress: RetireProgress): Promise<void> {
  const final = at(root, path.posix.join(RETIRING_DIR, `${pending.store}${RECEIPT_SUFFIX}`));
  if (pending.phase === "unmoved" && (await publicationAliasesMayExist(final))) return discardInterruptedReceipt(root, pending);
  const read = await readReceipt(root, pending.store);
  if (typeof read === "string" || read.sha256 !== pending.receiptSha256) throw new Error(`the cleanup receipt of ${pending.store} changed since the plan`);
  const phase = await pendingPhase(root, pending.store, read.receipt);
  if (phase !== pending.phase) throw new Error(`the cleanup of ${pending.store} changed since the plan`);
  // Only a quarantined store loses leaves; an unmoved one stays a store (it is re-planned), a removed one has nothing left.
  if (phase === "moved") {
    await syncRetirementParents(root);
    await removeQuarantined(root, pending.store, read.receipt.leaves, progress);
  }
  await removeReceipt(root, pending.store, read.sha256);
}

/** What one store's retirement needs from the inventory. */
export interface RetireTarget { readonly store: string; readonly eligibility: RunEligibilityV1; readonly manifestSha256: string; readonly leafDigest: string }

/** Refuse unless both parents of the rename are their real, confined in-root directories. */
async function assertConfinedParents(root: string): Promise<void> {
  for (const relDir of [INDEXED_DIR, RETIRING_DIR]) {
    if ((await realpath(at(root, relDir))) !== (await resolveExpectedReal(root, at(root, relDir)))) throw new Error(`${relDir} is redirected`);
  }
}

/** Create the private quarantine directory when absent, durably (its entry in `.llmwiki` is synced too). */
async function ensureQuarantine(root: string): Promise<void> {
  if (!(await ensureConfinedDirectory(root, RETIRING_DIR))) return;
  await chmod(at(root, RETIRING_DIR), PRIVATE_DIR_MODE);
  await fsyncConfinedDirectory(root, at(root, LLMWIKI_DIR));
}

/** The receipt's exact bytes, refused before anything is written when over its read cap. */
function receiptBytesOf(receipt: CleanupReceiptV1): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error(`the cleanup receipt of ${receipt.store} would exceed ${MAX_RECEIPT_BYTES} bytes; nothing was written`);
  return bytes;
}

/**
 * Retire one store: receipt, rename (the commit, reported to `progress` at once),
 * synced parents, then identity-bound cleanup (see the file comment).
 */
export async function retireStore(root: string, target: RetireTarget, token: string, progress: RetireProgress, step?: RetireStepForTest): Promise<StoreLeavesV1> {
  const relDir = path.posix.join(INDEXED_DIR, target.store);
  const leaves = await storeLeaves(root, relDir, await storeDirectory(root, target.store));
  if (typeof leaves === "string" || leaves.digest !== target.leafDigest) throw new Error(`run store ${target.store} changed since the plan`);
  const dir = await dirIdentity(root, relDir);
  if (dir === null) throw new Error(`run store ${target.store} vanished`);
  await ensureQuarantine(root);
  const receipt: CleanupReceiptV1 = {
    format: RECEIPT_FORMAT, version: 1, token, rootDigest: rootDigestOf(root), store: target.store, eligibility: target.eligibility, manifestSha256: target.manifestSha256, dir, leaves: leaves.identities,
  };
  const receiptBytes = receiptBytesOf(receipt);
  await atomicWrite(at(root, path.posix.join(RETIRING_DIR, `${target.store}${RECEIPT_SUFFIX}`)), receiptBytes, { confineRoot: root, exactParent: true, createOnly: true, mode: PRIVATE_FILE_MODE });
  await step?.("receipt", target.store);
  const quarantined = path.posix.join(RETIRING_DIR, target.store);
  if ((await dirIdentity(root, quarantined)) !== null) throw new Error(`${quarantined} already exists`);
  await assertConfinedParents(root);
  await rename(at(root, relDir), at(root, quarantined));
  progress.committed(target.store);
  await syncRetirementParents(root);
  await step?.("commit", target.store);
  await removeQuarantined(root, target.store, leaves.identities, progress, step);
  await removeReceipt(root, target.store, sha256Hex(receiptBytes));
  return leaves;
}

/** Remove the quarantine directory when nothing is left in it. */
export async function removeQuarantineIfEmpty(root: string): Promise<void> {
  const listing = await listConfinedDirBounded(root, RETIRING_DIR, 1);
  if (listing.kind === "ok" && listing.entries.length === 0) await rmdirConfinedDurable(root, at(root, RETIRING_DIR), at(root, LLMWIKI_DIR));
}
