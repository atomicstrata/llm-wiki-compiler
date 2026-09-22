/**
 * @file src/preparations/attempts/custody.ts
 * @description Two-phase output custody (design section 15.2 legs H and L). While
 * the project lock is RELEASED, a leg copies each output's bytes into a bounded,
 * host-owned TEMPORARY custody directory OUTSIDE the project/operator/cache and
 * re-hashes to verify the claimed digest. Authoritative publication into the
 * preparation evidence CAS happens ONLY under the project lock at commit, after
 * leg-K validation passes. On any park/drift/unsafe-effect the temporary custody
 * is discarded and nothing is published to the authoritative store, so a rejected
 * late result never leaves authoritative bytes behind.
 */

import { mkdtemp, open, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { streamPreparationEvidenceCreateOnly, type PreparationEvidenceLocation } from "../evidence-store.js";
import type { PendingEvidenceV1 } from "./types.js";

const CUSTODY_CHUNK_BYTES = 1024 * 1024;

/** The one prefix this module creates. */
const CUSTODY_DIR_PREFIX = "prep-attempt-custody-";

const SHA256_PREFIX = "sha256:";

/**
 * The custody directories THIS module actually created.
 *
 * `discardCustody` recursively deletes, and its argument arrives as
 * `AttemptLegOutcomeV1.custodyTempDir` -- a field the LEG fills in. A leg that
 * returns an arbitrary string therefore aims a recursive delete wherever it
 * likes, and `execute.ts` and `ephemeral-execute.ts` discard it unconditionally.
 *
 * FOUR successive attempts to validate that string failed review, each defeated
 * by the next variation: a lexical prefix compare missed a symlinked directory,
 * and every stricter pathname rule was still a check on a name that can mean
 * something different by the time the delete runs. The mistake was the question.
 * Validating the SHAPE of an untrusted path cannot establish that the path is
 * ours; only remembering what we created can.
 *
 * So this records PROVENANCE. A path that this module did not mint is refused
 * outright, whatever it looks like, which is the same move the lifecycle mutation
 * permit makes with its module-private brand. Entries are removed on discard, so
 * the set holds at most the directories currently in flight.
 *
 * It is deliberately NOT paired with a pathname rule. A second check here would
 * be redundant with this one and would make it impossible to tell, from a
 * mutation, which of the two was doing the work.
 */
const MINTED_CUSTODY_DIRS = new Set<string>();

/**
 * Create one bounded, host-owned temporary custody directory outside the project.
 *
 * DO NOT `realpath` THE RESULT. A previous version did, reasoning that resolving
 * once at creation was safer than re-deriving a path at delete time. It was the
 * opposite: `realpath` resolves a NAME, and between `mkdtemp` returning and the
 * resolution running, that name can be replaced with a symlink -- so the
 * attacker's target got recorded as the minted directory and was then recursively
 * deleted. Review reproduced exactly that swap.
 *
 * What is recorded is the literal path `mkdtemp` created: a direct child of the
 * temp root, made atomically, never re-interpreted.
 *
 * This does NOT remove the window -- another process able to write the temp root
 * can replace that name at any point up to the discard. It changes what a swap can
 * achieve. Resolving recorded the symlink's TARGET, an attacker-chosen path
 * elsewhere on disk, and deleting that is the escape; recording the literal name
 * keeps the swapped component FINAL, and `rm` unlinks a final symlink rather than
 * following it. The regressions pin that, rather than citing it.
 */
export async function createCustodyDir(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), CUSTODY_DIR_PREFIX));
  MINTED_CUSTODY_DIRS.add(created);
  return created;
}

/**
 * Best-effort discard of a temporary custody directory this module created.
 *
 * Recursive, and bounded by PROVENANCE rather than by inspecting the path: only a
 * directory returned by `createCustodyDir` and not yet discarded is removed. A
 * leg-supplied path is refused silently, because discarding scratch is never
 * worth the one call that could recursively delete something else.
 *
 * §16 clause 5 bans recursive LIFECYCLE deletion; this is host-owned scratch under
 * the OS temp root holding unpublished bytes, so it is outside that scope -- and
 * that is now true by construction rather than by assertion.
 */
export async function discardCustody(tempDir: string | undefined): Promise<void> {
  if (tempDir === undefined) return;
  if (!MINTED_CUSTODY_DIRS.delete(tempDir)) return;
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Copy one host output path into `<tempDir>/<bareDigest>` in bounded chunks,
 * hashing as it copies, and return the byte count only when the bytes hash to
 * exactly `bareDigest` within the ceiling; any oversize, read fault, or digest
 * disagreement returns null so the caller fails closed.
 */
export async function copyIntoCustody(
  sourcePath: string, tempDir: string, bareDigest: string, cap: number,
): Promise<number | null> {
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let dest: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    // The destination open is INSIDE the try: a create-only collision (two outputs
    // hashing alike) must fail this copy closed, never throw past the caller's
    // custody discard and strand a temporary directory (zero-write violation).
    dest = await open(path.join(tempDir, bareDigest), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    return await streamVerifiedCopy(source, dest, bareDigest, cap);
  } catch { return null; } finally {
    await source?.close().catch(() => {});
    await dest?.close().catch(() => {});
  }
}

/** Stream source→dest, hashing and capping; null on cap/fault/digest mismatch. */
async function streamVerifiedCopy(
  source: Awaited<ReturnType<typeof open>>, dest: Awaited<ReturnType<typeof open>>, bareDigest: string, cap: number,
): Promise<number | null> {
  const hash = createHash("sha256");
  const scratch = Buffer.allocUnsafe(CUSTODY_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    const read = await source.read(scratch, 0, scratch.byteLength, total);
    if (read.bytesRead === 0) break;
    if (total + read.bytesRead > cap) return null;
    await dest.write(scratch, 0, read.bytesRead, total);
    hash.update(scratch.subarray(0, read.bytesRead));
    total += read.bytesRead;
  }
  return hash.digest("hex") === bareDigest ? total : null;
}

/** Re-hash one temporary custody object and confirm it matches its ref exactly. */
async function verifyTempObject(item: PendingEvidenceV1, cap: number): Promise<boolean> {
  if (item.ref.byteCount > cap) return false;
  let handle;
  try {
    handle = await open(item.tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch { return false; }
  try {
    const hash = createHash("sha256");
    const scratch = Buffer.allocUnsafe(CUSTODY_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = await handle.read(scratch, 0, scratch.byteLength, total);
      if (read.bytesRead === 0) break;
      if (total + read.bytesRead > cap) return false;
      hash.update(scratch.subarray(0, read.bytesRead));
      total += read.bytesRead;
    }
    return total === item.ref.byteCount && hash.digest("hex") === item.ref.digest.slice(SHA256_PREFIX.length);
  } catch { return false; } finally {
    await handle.close().catch(() => {});
  }
}

/** Link one verified temporary object into the create-only evidence CAS. */
async function linkIntoCas(root: string, location: PreparationEvidenceLocation, item: PendingEvidenceV1, cap: number): Promise<boolean> {
  const bare = item.ref.digest.slice(SHA256_PREFIX.length);
  let handle;
  try {
    handle = await open(item.tempPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch { return false; }
  try {
    const streamed = await streamPreparationEvidenceCreateOnly(root, location, handle, bare, cap);
    return streamed.status === "written" && streamed.byteCount === item.ref.byteCount;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * TRANSACTIONALLY publish pending evidence into the preparation CAS under the
 * project lock: FIRST re-verify EVERY temporary object (present, digest-valid,
 * within the ceiling); only then link them. A single unverifiable object rejects
 * the whole batch before ANY link. A link failure after verification — whether a
 * thrown fault or a rejected status — returns false so the caller durably PARKS
 * (recovery-required, owner cleared). This never unlinks a CAS object: a
 * pre-existing shared object is never deleted, and any object this batch newly
 * linked before failing is an inert orphan (no run reference is settled on a
 * park), which the preparation orphan scan reclaims (RC-C).
 */
export async function publishCustodyLocked(
  root: string, location: PreparationEvidenceLocation, pending: readonly PendingEvidenceV1[], cap: number,
): Promise<boolean> {
  for (const item of pending) {
    if (!(await verifyTempObject(item, cap))) return false;
  }
  try {
    for (const item of pending) if (!(await linkIntoCas(root, location, item, cap))) return false;
  } catch {
    return false;
  }
  return true;
}
