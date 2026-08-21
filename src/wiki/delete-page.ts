/**
 * @file src/wiki/delete-page.ts
 * @description Journalled deletion of wiki concept pages — the delete
 * counterpart to the journalled write batch in `src/compiler/compile-write.ts`.
 *
 * Every wiki page WRITE in llmwiki routes through a journal batch so a crash
 * mid-mutation replays back to the pre-state. Deletion needs the same guarantee,
 * and needs it more: `llmwiki rm` has no confirmation prompt, so the journal is
 * the ONLY recovery path if the process dies partway through a removal.
 *
 * Each page's bytes are recorded via `recordPreState` BEFORE it is unlinked, so
 * `replayJournal` restores every page in a batch that never committed. That buys
 * crash-recovery WITHOUT extending the trust executor: this module composes the
 * same public journal primitives the write path composes.
 *
 * Two contracts are deliberately mirrored from `applyCompilePageWritesLocked`:
 *
 *  - SKIP, NOT ABORT. A slug failing the {@link isSafeFilenameComponent} floor is
 *    reported in `skipped`, never path-joined, and never fatal to the rest of the
 *    batch — an out-of-tree slug must not be able to cancel a legitimate removal.
 *  - EMPTY ⇒ NO-OP. With nothing deletable, NO batch is opened, so a no-op
 *    removal leaves no dangling pending batch and no false recovery window.
 *
 * PRECONDITION: the caller MUST already hold the project lock. This acquires
 * nothing, so it is safe inside an outer locked region.
 */

import path from "path";
import { lstat } from "fs/promises";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { openBatch, recordPreState, commitBatch, replayJournal, confinedUnlink } from "../trust/journal.js";

/** The unlink primitive, injectable so a crash mid-batch is testable. */
export type UnlinkOne = (targetPath: string) => Promise<void>;

/** A page the batch refused to delete, with the floor that refused it. */
export interface SkippedDelete {
  /** The offending slug, as supplied. */
  slug: string;
  /** Machine-readable reason, prefixed `floor:` like the write path's skips. */
  reason: string;
}

/** Options for {@link deleteWikiPagesLocked}. */
export interface DeleteOptions {
  /** Override the unlink primitive (fault injection). Defaults to `confinedUnlink`. */
  unlinkOne?: UnlinkOne;
}

/**
 * Delete concept pages as ONE journalled batch under the caller's held lock.
 *
 * Every unlink is VERIFIED, not trusted. `confinedUnlink`'s catch is shared
 * with the journal's own revert path, where swallowing any error is correct
 * (an absent target IS the goal there). Reused here for a DELETE, that same
 * catch also swallows EACCES/EROFS/EBUSY — real failures that leave the page
 * on disk. So after `unlinkOne` returns, {@link assertUnlinked} re-checks the
 * target and THROWS if it is still present, rather than letting the loop
 * reach `commitBatch` and report success for a delete that never happened.
 * The throw lands BEFORE commit, so the batch stays `pending` — its journal
 * file, and every pre-state recorded so far (including siblings this same
 * batch DID delete), survives for a later {@link replayJournal} to restore.
 *
 * @param root - Absolute project root.
 * @param slugs - Bare concept slugs (no `.md`, no directory part).
 * @param opts - Optional injectable unlink primitive.
 * @returns The floor-skipped slugs; allowed pages are deleted as a side
 *   effect. Throws if an allowed page survives its unlink attempt, leaving
 *   the batch pending for replay instead of reporting a false success.
 */
export async function deleteWikiPagesLocked(
  root: string,
  slugs: string[],
  opts: DeleteOptions = {},
): Promise<{ skipped: SkippedDelete[] }> {
  // Replay-before-mutate, under the held lock: recover any batch a prior crash
  // left pending BEFORE opening a new one. Mirrors the executor's dispatch.
  await replayJournal(root);

  const { allowed, skipped } = partitionBySlugFloor(slugs);
  if (allowed.length === 0) return { skipped };

  const unlinkOne = opts.unlinkOne ?? ((target: string) => confinedUnlink(target, root));
  const batch = await openBatch(root);
  for (const slug of allowed) {
    const target = path.join(root, CONCEPTS_DIR, `${slug}.md`);
    await recordPreState(batch, target);
    await unlinkOne(target);
    await assertUnlinked(target, slug);
  }
  await commitBatch(batch);
  return { skipped };
}

/**
 * Confirm `target` is actually gone after `unlinkOne` returns, so a swallowed
 * unlink failure can never be misreported as a completed delete. `lstat`, not
 * `stat`: a symlink LEAF must still count as present rather than being
 * followed and misread as absent.
 *
 * @param target - Absolute path the batch attempted to unlink.
 * @param slug - The slug being deleted, named in the thrown error so a caller
 *   can tell which page failed.
 */
async function assertUnlinked(target: string, slug: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return; // gone — the delete succeeded
    throw error; // an unexpected lstat fault is a real problem, not "still there"
  }
  throw new Error(`failed to delete wiki page "${slug}": file still exists after unlink`);
}

/**
 * Split slugs by the filename floor. The floor is applied HERE, independently of
 * any caller-side validation, so an out-of-tree slug can never reach a path-join
 * no matter who calls this.
 */
function partitionBySlugFloor(slugs: string[]): { allowed: string[]; skipped: SkippedDelete[] } {
  const allowed: string[] = [];
  const skipped: SkippedDelete[] = [];
  for (const slug of slugs) {
    if (isSafeFilenameComponent(slug)) allowed.push(slug);
    else skipped.push({ slug, reason: "floor:unsafe-slug" });
  }
  return { allowed, skipped };
}
