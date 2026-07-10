/**
 * @file src/trust/journal-recovery.ts
 * @description STRICT, FAIL-CLOSED pre-compile journal recovery — the entry point
 * `compile` runs BEFORE it opens its own journalled batches.
 *
 * The existing {@link replayJournal} is BEST-EFFORT: on a malformed or
 * target-escaping batch it QUARANTINES the file and continues, because it runs
 * inline right before a single `review approve` mutation where pressing on is the
 * safer default. Compile is different: it opens FIVE journalled batches per run
 * (× repeated watch/refresh), so a journal it cannot cleanly recover is a signal
 * the page store may be in an inconsistent state — pressing on could compound the
 * damage. {@link recoverJournalBeforeCompile} therefore refuses to silently
 * quarantine-and-continue: any non-revertable condition surfaces as `unsafe` so
 * the caller can fail the compile loudly.
 *
 * It shares the journal's own primitives (classify dir, load+shape-validate a
 * batch, whole-batch confinement gate, per-entry re-confined revert) so the
 * strict path and the best-effort path agree on what a valid, confined,
 * revertable batch is — only the response to a NON-revertable batch differs.
 */

import { unlink } from "fs/promises";
import {
  classifyJournalDir,
  loadBatch,
  revertEntry,
  journalPath,
  type JournalBatch,
} from "./journal.js";
import { classifyJournalFile, listBatchIds } from "./journal-classify.js";

/** The outcome of a strict pre-compile recovery pass. */
export type RecoveryStatus = "clean" | "replayed" | "unsafe";

/** Typed error used INTERNALLY to short-circuit the recovery loop on any non-revertable batch. */
export class JournalUnsafeError extends Error {
  constructor(reason: string) {
    super(`journal recovery unsafe: ${reason}`);
    this.name = "JournalUnsafeError";
  }
}

/**
 * Strictly recover the journal directory before a compile run begins.
 *
 * Iterates the CONFINED journal directory and, for every PENDING batch, attempts
 * a full strict revert to its recorded pre-state. STRICTER than
 * {@link replayJournal}: rather than quarantine-and-continue, ANY non-revertable
 * condition fails closed as `unsafe`. Legacy `committed` files (old pre-state
 * copies) are pruned.
 *
 * Returns:
 *  - `clean`    — dir absent, or nothing pending after pruning legacy committed files;
 *  - `replayed` — at least one pending batch was fully reverted and its file deleted;
 *  - `unsafe`   — the dir symlink-escapes root, a pending file is malformed/unreadable
 *                 (`loadBatch` null), or a recorded target escapes root.
 *
 * @param root - Absolute project root whose journal directory is recovered.
 * @returns The recovery {@link RecoveryStatus}.
 */
export async function recoverJournalBeforeCompile(
  root: string,
): Promise<{ status: RecoveryStatus }> {
  const dirState = await classifyJournalDir(root);
  if (dirState.kind === "absent") return { status: "clean" };
  if (dirState.kind === "escape") return { status: "unsafe" };
  try {
    return { status: await recoverPendingBatches(root, dirState.dir) };
  } catch (err) {
    if (err instanceof JournalUnsafeError) return { status: "unsafe" };
    throw err;
  }
}

/**
 * Revert every pending batch in the confined journal dir, pruning legacy
 * committed files. Returns `replayed` if any pending batch was reverted, else
 * `clean`. Throws {@link JournalUnsafeError} on the first non-revertable batch.
 */
async function recoverPendingBatches(root: string, confinedDir: string): Promise<RecoveryStatus> {
  let replayedAny = false;
  for (const batchId of await listBatchIds(confinedDir)) {
    if (await recoverOneBatch(root, batchId)) replayedAny = true;
  }
  return replayedAny ? "replayed" : "clean";
}

/**
 * Recover a single batch, acting on the SHARED {@link classifyJournalFile}
 * verdict so the strict gate and the read-only health detector can never disagree
 * on what is `unsafe`. Prunes a legacy committed file (returns false). Fully
 * reverts a pending batch and deletes its journal (returns true). Throws
 * {@link JournalUnsafeError} when the file is malformed/unreadable or names an
 * escaping target.
 */
async function recoverOneBatch(root: string, batchId: string): Promise<boolean> {
  const verdict = await classifyJournalFile(root, batchId);
  if (verdict === "unsafe") {
    throw new JournalUnsafeError(`non-revertable journal ${batchId}.json`);
  }
  if (verdict === "legacy-committed") {
    await unlink(journalPath(root, batchId)); // prune a legacy committed file
    return false;
  }
  await revertPendingBatch(root, await loadConfinedPending(root, batchId));
  return true;
}

/**
 * Re-load a batch the shared classifier already verdicted `pending-revertable`,
 * guarding the (vanishingly unlikely) concurrent-tamper window where the file
 * changed between classify and revert by failing closed as unsafe.
 */
async function loadConfinedPending(root: string, batchId: string): Promise<JournalBatch> {
  const batch = await loadBatch(root, batchId);
  if (batch === null) throw new JournalUnsafeError(`journal vanished ${batchId}.json`);
  return batch;
}

/** Revert every entry of a confined pending batch, then delete its journal file. */
async function revertPendingBatch(root: string, batch: JournalBatch): Promise<void> {
  for (const entry of batch.entries) {
    await revertEntry(entry, root);
  }
  await unlink(journalPath(root, batch.batchId));
}
