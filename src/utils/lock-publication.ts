/**
 * @file Create-only publication of a lock leaf that is never observable empty.
 * @description A lock file is both the mutual-exclusion token AND the record
 * naming its owner, so the two must become visible together. Creating the final
 * name first and writing the owner record into it second makes the lock briefly
 * a ZERO-BYTE file under its authoritative name — and an empty leaf is exactly
 * what {@link ../utils/lock.js lockHolderState} classifies as stale and reclaimable,
 * because an unreadable owner has to stay recoverable. A contender polling in
 * that window therefore unlinks a lock a LIVE process is in the middle of
 * taking, creates its own, and both processes proceed believing they hold it.
 * Serializing reclaimers cannot close that: the window belongs to the creator,
 * so re-verifying staleness under a reclaim lock re-reads the same empty file.
 *
 * This module publishes instead: the complete owner record is written to a
 * uniquely named same-directory scratch leaf, which is then linked onto the
 * authoritative name through `linkTempNoReplace` — the repository's
 * create-only commit primitive, whose `EEXIST` means another acquirer published
 * first. The authoritative name goes from absent to complete in one step, so
 * there is no interval in which a reader can see a live lock as empty.
 *
 * The scratch name carries per-acquirer entropy on purpose. The durable writer's
 * fixed `<file>.tmp` reservation is safe for content-addressed writes, where
 * every writer's bytes are identical; lock records are NOT interchangeable, and
 * a shared scratch name would let one acquirer publish another's owner record.
 *
 * STORAGE. {@link publishLockRecordFrom} is THE ONE BODY, over two separate
 * capabilities it is handed: {@link LockPublicationIo}, the raw physical file
 * operations, and a {@link ScratchEntropy} HOST port for the scratch name's
 * randomness (not a storage policy). The body keeps every decision — the
 * scratch name, the create-outside-try order, the hook position, the collision
 * class test and the best-effort cleanup. The root {@link publishLockRecord}
 * keeps its signature and passes {@link diskLockPublicationIo} and
 * {@link hostScratchEntropy}. Nothing here knows about lock ownership, process
 * liveness or staleness; acquisition and release stay in `./lock.ts`.
 */

import { randomBytes } from "node:crypto";
import { removeLeaf } from "../storage/disk-guarded-leaves.js";
import { createPrivateLeafExclusive, linkPrivateLeafNoReplace } from "../storage/disk-private-leaves.js";
import { AtomicWriteCollisionError } from "./atomic-write-no-replace-durable.js";

/**
 * Entropy in the scratch leaf name. Distinguishes concurrent acquirers, and —
 * unlike a bare pid — also distinguishes an acquirer from a leaf abandoned by a
 * process whose pid has since been reused.
 */
const SCRATCH_ENTROPY_BYTES = 8;

/**
 * The RAW physical I/O one publication asks for. Each member gives a physical
 * answer only and decides nothing; it is not hosted, access-controlled, durable
 * (no `fsync`) or identity-guarded, and it is in no package index.
 */
export interface LockPublicationIo {
  /**
   * Create `leaf` exclusively (`wx`, the process default mode filtered by the
   * umask), write `text`, close. REJECTS raw — an existing name or link included —
   * and a failure after the write (a rejecting close) leaves the leaf behind.
   * Disk: `createPrivateLeafExclusive`.
   */
  createLeafExclusive(leaf: string, text: string): Promise<void>;
  /**
   * Give the file at `from` the second name `to`, never replacing: an existing
   * `to` REJECTS with `AtomicWriteCollisionError` and is untouched; every other
   * failure REJECTS raw. Disk: `linkPrivateLeafNoReplace`.
   */
  linkLeafNoReplace(from: string, to: string): Promise<void>;
  /** Unlink `leaf`, by path. REJECTS raw. Disk: `removeLeaf`. */
  removeLeaf(leaf: string): Promise<void>;
}

/** LOCAL DISK. The incumbent primitives, called at call time; no state, frozen. */
export const diskLockPublicationIo: LockPublicationIo = Object.freeze({
  createLeafExclusive: (leaf: string, text: string) => createPrivateLeafExclusive(leaf, text),
  linkLeafNoReplace: (from: string, to: string) => linkPrivateLeafNoReplace(from, to),
  removeLeaf: (leaf: string) => removeLeaf(leaf),
});

/** HOST capability, not storage: `bytes` of FRESH entropy as lowercase hex, a new value on every call. */
export type ScratchEntropy = (bytes: number) => string;

/** LOCAL HOST. `randomBytes(bytes).toString("hex")`, called at call time. */
export const hostScratchEntropy: ScratchEntropy = (bytes) => randomBytes(bytes).toString("hex");

/** Seams observing one publication; supplied by tests, absent in production. */
export interface LockPublicationHooks {
  /**
   * Awaited immediately BEFORE the create-only publication, with the complete
   * scratch record already on disk. This is the only interval in which a
   * contender may legitimately win, so it is the interval a race regression
   * must be able to hold open deterministically.
   */
  beforePublish?: () => Promise<void>;
}

/**
 * Publish `ownerRecord` under `lockPath`, create-only.
 *
 * @param lockPath - Absolute path of the authoritative lock leaf.
 * @param ownerRecord - The COMPLETE serialized owner record.
 * @param hooks - Optional publication seams (tests only).
 * @returns `true` when this caller published the lock, `false` when the name was
 *   already taken — the same two-valued answer the previous `open(wx)` gave, so
 *   callers keep their existing control flow.
 */
export async function publishLockRecord(
  lockPath: string,
  ownerRecord: string,
  hooks: LockPublicationHooks = {},
): Promise<boolean> {
  return publishLockRecordFrom(diskLockPublicationIo, hostScratchEntropy, lockPath, ownerRecord, hooks);
}

/**
 * THE ONE BODY of {@link publishLockRecord}, over the raw I/O and the entropy
 * port it is handed. The create is OUTSIDE the try: a failed create (even one
 * that wrote before failing) is NOT cleaned up. An `AtomicWriteCollisionError`
 * raised inside the try — by the link, or (inherited) by the `beforePublish`
 * hook — means "taken" (`false`); everything else propagates. The scratch
 * alias is removed on every outcome after a successful create, best-effort.
 */
export async function publishLockRecordFrom(
  io: LockPublicationIo,
  entropy: ScratchEntropy,
  lockPath: string,
  ownerRecord: string,
  hooks: LockPublicationHooks = {},
): Promise<boolean> {
  const scratchPath = lockScratchPath(lockPath, entropy);
  // Write the whole record and close, so the leaf is complete before it is linked.
  //
  // The mode is left at the process default DELIBERATELY, but the default does
  // NOT guarantee cross-UID readability and this comment must not imply it does:
  // `open(…, "wx")` requests `0o666` and the kernel filters it through the
  // process umask, so a `0o077` umask yields `0o600` here anyway.
  //
  // What the default does guarantee is that publication is no more restrictive
  // than the create-then-write it replaces, and that matters because this leaf's
  // readability is load-bearing: `lockHolderState` treats an owner it cannot read as
  // stale, so a lock another UID is unable to open is classified reclaimable and
  // reclaimed from its live owner — double ownership by a different route.
  // Hard-coding `0o600` would make that failure UNCONDITIONAL, which is the only
  // reason the mode is unspecified. Under a restrictive umask the hazard remains,
  // and closing it needs the staleness predicate to distinguish "cannot read" from
  // "does not qualify" — out of scope here, and not fixed by a mode argument.
  await io.createLeafExclusive(scratchPath, ownerRecord);
  try {
    await hooks.beforePublish?.();
    await io.linkLeafNoReplace(scratchPath, lockPath);
    return true;
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) return false;
    throw error;
  } finally {
    // Drop our alias on BOTH outcomes so the published lock settles at nlink=1
    // and a loser leaves nothing behind. A hard kill between the write and this
    // unlink leaks one small scratch leaf; that residue is deliberately NOT
    // swept by name, because a filename is not a classification of the content
    // beneath it and a pattern-matched unlink inside the private directory is a
    // worse hazard than the litter it removes.
    await io.removeLeaf(scratchPath).catch(() => {});
  }
}

/** Reserve one acquirer's scratch leaf beside the lock it intends to publish, with fresh host entropy. */
function lockScratchPath(lockPath: string, entropy: ScratchEntropy): string {
  return `${lockPath}.${entropy(SCRATCH_ENTROPY_BYTES)}.publishing`;
}
