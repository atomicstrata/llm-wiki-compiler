/**
 * Commander action for `llmwiki recover` — the standalone journal-recovery
 * escape hatch that pairs with `state reset`.
 *
 * After a crashed compile the intent journal is left `pending`, and every read
 * surface flags `incomplete-compile` until the NEXT compile recovers it (via
 * {@link recoverJournalBeforeCompile}). A user who can't or won't run a full
 * recompile would otherwise be stuck with the warnings and a partial page store.
 * This command runs the SAME strict recovery pass in isolation — reverting an
 * incomplete compile to its recorded pre-state — without recompiling anything.
 *
 * SAFETY: recovery REVERTS page bytes, so it must never race a concurrent
 * compile/writeState. It acquires the project LOCK first (refusing cleanly with a
 * non-zero exit if another live process holds it) and always releases it in a
 * `finally`. The recovery itself confines the journal directory and every recorded
 * target to the project root; a symlink-escaping journal or an out-of-tree target
 * surfaces as `unsafe` and exits non-zero without touching anything outside root.
 */

import {
  recoverJournalBeforeCompile,
  JournalUnsafeError,
  type RecoveryStatus,
} from "../trust/journal-recovery.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import * as output from "../utils/output.js";

/**
 * Report a successful recovery outcome (`clean` or `replayed`). Both are exit-0
 * states: nothing to recover, or an incomplete compile was reverted.
 *
 * @param status - The non-`unsafe` recovery status to map to a success line.
 */
function reportRecovered(status: Exclude<RecoveryStatus, "unsafe">): void {
  if (status === "clean") {
    output.status("✓", output.success("Nothing to recover."));
    return;
  }
  output.status("✓", output.success("Reverted an incomplete compile."));
}

/**
 * Announce an `unsafe` recovery and flag the run as failed. The journal is
 * tampered or otherwise non-revertable; recovery confined every path, so nothing
 * outside root was touched. Exits non-zero so callers/CI never read it as success.
 */
function reportUnsafe(): void {
  output.status(
    "!",
    output.error("Journal is tampered or unsafe — refusing to recover. Inspect .llmwiki/journal."),
  );
  process.exitCode = 1;
}

/**
 * Run the strict recovery pass under the project lock and report its outcome.
 *
 * {@link recoverJournalBeforeCompile} RETURNS `{status:"unsafe"}` (it catches its
 * own {@link JournalUnsafeError} internally); we also catch a thrown
 * `JournalUnsafeError` for defence in depth so both shapes map to the same
 * non-zero `unsafe` report. The lock is always released.
 *
 * @param root - Absolute project root whose journal is recovered.
 */
async function runRecoveryUnderLock(root: string): Promise<void> {
  try {
    const { status } = await recoverJournalBeforeCompile(root);
    if (status === "unsafe") {
      reportUnsafe();
      return;
    }
    reportRecovered(status);
  } catch (err) {
    if (err instanceof JournalUnsafeError) {
      reportUnsafe();
      return;
    }
    throw err;
  }
}

/**
 * Recover an incomplete compile WITHOUT a full recompile.
 *
 * Acquires the project lock (refusing cleanly with a non-zero exit when another
 * live process holds it), runs the strict {@link recoverJournalBeforeCompile}
 * pass, and reports the outcome:
 *  - `clean`    → "Nothing to recover." (exit 0);
 *  - `replayed` → "Reverted an incomplete compile." (exit 0);
 *  - `unsafe`   → a prominent tampered/unsafe error (exit non-zero).
 *
 * The lock is always released.
 */
export async function recoverCommand(): Promise<void> {
  const root = process.cwd();
  const acquired = await acquireLock(root);
  if (!acquired) {
    output.status("!", output.warn("Another llmwiki process is using this project; not recovering."));
    process.exitCode = 1; // requested recovery did NOT happen → non-zero exit
    return;
  }
  try {
    await runRecoveryUnderLock(root);
  } finally {
    await releaseLock(root);
  }
}
