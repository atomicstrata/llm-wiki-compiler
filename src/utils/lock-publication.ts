/**
 * @file Create-only publication of a lock leaf that is never observable empty.
 * @description A lock file is both the mutual-exclusion token AND the record
 * naming its owner, so the two must become visible together. Creating the final
 * name first and writing the owner record into it second makes the lock briefly
 * a ZERO-BYTE file under its authoritative name — and an empty leaf is exactly
 * what {@link ../utils/lock.js isLockStale} classifies as stale and reclaimable,
 * because an unreadable owner has to stay recoverable. A contender polling in
 * that window therefore unlinks a lock a LIVE process is in the middle of
 * taking, creates its own, and both processes proceed believing they hold it.
 * Serializing reclaimers cannot close that: the window belongs to the creator,
 * so re-verifying staleness under a reclaim lock re-reads the same empty file.
 *
 * This module publishes instead: the complete owner record is written to a
 * uniquely named same-directory scratch leaf, which is then linked onto the
 * authoritative name through {@link linkTempNoReplace} — the repository's
 * create-only commit primitive, whose `EEXIST` means another acquirer published
 * first. The authoritative name goes from absent to complete in one step, so
 * there is no interval in which a reader can see a live lock as empty.
 *
 * The scratch name carries per-acquirer entropy on purpose. The durable writer's
 * fixed `<file>.tmp` reservation is safe for content-addressed writes, where
 * every writer's bytes are identical; lock records are NOT interchangeable, and
 * a shared scratch name would let one acquirer publish another's owner record.
 */

import { open, unlink } from "fs/promises";
import { randomBytes } from "node:crypto";
import { AtomicWriteCollisionError, linkTempNoReplace } from "./atomic-write-no-replace-durable.js";

/**
 * Entropy in the scratch leaf name. Distinguishes concurrent acquirers, and —
 * unlike a bare pid — also distinguishes an acquirer from a leaf abandoned by a
 * process whose pid has since been reused.
 */
const SCRATCH_ENTROPY_BYTES = 8;

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
  const scratchPath = lockScratchPath(lockPath);
  await writeCompleteRecord(scratchPath, ownerRecord);
  try {
    await hooks.beforePublish?.();
    await linkTempNoReplace(scratchPath, lockPath);
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
    await unlink(scratchPath).catch(() => {});
  }
}

/** Reserve one acquirer's scratch leaf beside the lock it intends to publish. */
function lockScratchPath(lockPath: string): string {
  return `${lockPath}.${randomBytes(SCRATCH_ENTROPY_BYTES).toString("hex")}.publishing`;
}

/**
 * Write the whole record and close, so the leaf is complete before it is linked.
 *
 * The mode is left at the process default DELIBERATELY, but the default does
 * NOT guarantee cross-UID readability and this comment must not imply it does:
 * `open(…, "wx")` requests `0o666` and the kernel filters it through the
 * process umask, so a `0o077` umask yields `0o600` here anyway.
 *
 * What the default does guarantee is that publication is no more restrictive
 * than the create-then-write it replaces, and that matters because this leaf's
 * readability is load-bearing: `isLockStale` treats an owner it cannot read as
 * stale, so a lock another UID is unable to open is classified reclaimable and
 * reclaimed from its live owner — double ownership by a different route.
 * Hard-coding `0o600` would make that failure UNCONDITIONAL, which is the only
 * reason the mode is unspecified. Under a restrictive umask the hazard remains,
 * and closing it needs the staleness predicate to distinguish "cannot read" from
 * "does not qualify" — out of scope here, and not fixed by a mode argument.
 */
async function writeCompleteRecord(scratchPath: string, ownerRecord: string): Promise<void> {
  const handle = await open(scratchPath, "wx");
  try {
    await handle.writeFile(ownerRecord, "utf-8");
  } finally {
    await handle.close();
  }
}
