/**
 * @file src/trust/journal-classify.ts
 * @description The SINGLE shared journal classifier both the strict, MUTATING
 * pre-compile gate ({@link recoverJournalBeforeCompile}) and the read-only health
 * detector ({@link journalHealth}) consume, so they can never disagree on what is
 * `unsafe`/`unavailable` versus a clean (committed/absent) or pending state.
 *
 * Classification is PURE (no writes, no replay, no prune): given a project root
 * and a batch id it loads + shape-validates the file and applies the whole-batch
 * confinement gate, reporting one of three categories. Each consumer then decides
 * what to DO with that category — the strict gate prunes/reverts, the read-only
 * detector merely reports — but the categorization itself lives here exactly once.
 *
 * It reuses the journal's own primitives ({@link loadBatch}, {@link allTargetsConfined})
 * so the strict path and the read-only path share the same definition of a valid,
 * confined batch, and also owns the shared {@link listBatchIds} iteration so both
 * consumers enumerate the journal dir identically.
 */

import { readdir } from "fs/promises";
import { loadBatch, allTargetsConfined } from "./journal.js";

/**
 * The classification of a single journal file:
 *  - `legacy-committed` — a cleanly-loadable non-pending (committed) batch: a
 *    stale pre-state copy that needs no recovery (the strict gate prunes it,
 *    health ignores it);
 *  - `pending-revertable` — a cleanly-loadable `status:"pending"` batch whose
 *    every target confines under root (an incomplete compile, safe to revert);
 *  - `unsafe` — the file is malformed/unreadable, OR names a target that escapes
 *    root. A tamper/corruption is ALWAYS this, never one of the clean categories.
 */
export type JournalFileClass = "legacy-committed" | "pending-revertable" | "unsafe";

/**
 * Classify one journal batch file purely from disk, applying the SAME load,
 * shape-validation, and whole-batch confinement checks the strict recovery gate
 * uses — but performing NO mutation. Both the mutating gate and the read-only
 * detector call this so they can never drift on what counts as `unsafe`.
 *
 * @param root - Absolute project root the journal hangs off.
 * @param batchId - The `<batchId>` stem of the journal file to classify.
 * @returns The file's {@link JournalFileClass}.
 */
export async function classifyJournalFile(
  root: string,
  batchId: string,
): Promise<JournalFileClass> {
  const batch = await loadBatch(root, batchId);
  if (batch === null) return "unsafe"; // unreadable JSON or malformed shape
  if (batch.status !== "pending") return "legacy-committed";
  if (!(await allTargetsConfined(batch))) return "unsafe"; // a target escapes root
  return "pending-revertable";
}

/**
 * List the `<batchId>` stems of every `.json` file directly in the confined
 * journal dir — the single shared iteration both the strict gate and the
 * read-only detector use to enumerate batches before classifying each.
 *
 * @param confinedDir - The confined absolute journal directory to list.
 * @returns The batch-id stems (filenames with the trailing `.json` removed).
 */
export async function listBatchIds(confinedDir: string): Promise<string[]> {
  const files = await readdir(confinedDir);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}
