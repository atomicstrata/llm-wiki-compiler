/**
 * @file src/trust/journal.ts
 * @description The single-store INTENT JOURNAL for the PAGE store — the
 * durability record that realizes the CLP atomicity contract: "partial
 * application of an approved mutation batch is a bug."
 *
 * A batch is journalled under `.llmwiki/journal/<batchId>.json` in two phases:
 *
 *  1. `pending` — opened and persisted BEFORE any file write lands. For every
 *     target it records the PRE-STATE: the prior file bytes, or an `absent`
 *     marker when the target did not exist. This is the information a revert
 *     needs to restore the exact world that existed before the batch began.
 *  2. `committed` — written once EVERY file write in the batch has succeeded.
 *
 * {@link replayJournal} is the crash-recovery seam, run on startup. For any
 * `pending`-but-not-`committed` batch it REVERTS every recorded target to its
 * pre-state — restoring prior bytes, or deleting a file that was absent
 * pre-batch — then resolves (deletes) the journal. A committed batch is left
 * untouched. Replay is idempotent: once a pending batch is reverted its journal
 * is gone, so a second pass finds nothing to do.
 *
 * The journal NEVER records a post-state, so a half-applied batch can only ever
 * resolve toward the FULL pre-state, never toward a partial post-state. All
 * journal files live under `.llmwiki/`, the project's existing private dir.
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename } from "fs/promises";
import path from "path";
import { LLMWIKI_DIR } from "../utils/constants.js";

/** Sentinel recorded when a target did not exist before the batch. */
const ABSENT = { absent: true } as const;

/** The pre-state of one target: prior file bytes, or the absent marker. */
export type PreState = { absent: true } | { absent: false; content: string };

/** One target's recorded pre-state under its absolute on-disk path. */
export interface JournalEntry {
  /** Absolute path of the target file this batch will write. */
  targetPath: string;
  /** What existed at `targetPath` before the batch began. */
  preState: PreState;
}

/** Lifecycle status of a journalled batch. */
export type BatchStatus = "pending" | "committed";

/** A journalled batch of planned writes plus the project root it lives in. */
export interface JournalBatch {
  /** Unique id; also the journal filename stem. */
  batchId: string;
  /** Project root the journal directory hangs off. */
  root: string;
  /** Lifecycle status. */
  status: BatchStatus;
  /** Per-target pre-state records, in declaration order. */
  entries: JournalEntry[];
}

/** Absolute path to the journal directory for a project root. */
function journalDir(root: string): string {
  return path.join(root, LLMWIKI_DIR, "journal");
}

/** Absolute path to a batch's journal file. */
function journalPath(root: string, batchId: string): string {
  return path.join(journalDir(root), `${batchId}.json`);
}

/** Read a file's bytes, or `null` when it does not exist. */
async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Atomically persist a batch's current state to its journal file. */
async function persist(batch: JournalBatch): Promise<void> {
  const file = journalPath(batch.root, batch.batchId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = {
    batchId: batch.batchId,
    status: batch.status,
    entries: batch.entries,
  };
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf-8");
  await rename(tmp, file);
}

/**
 * Open a fresh `pending` batch and persist its (empty) journal file. Targets
 * are recorded one at a time via {@link recordPreState} before any write lands.
 *
 * @param root - Absolute project root the journal hangs off.
 * @returns The opened, persisted {@link JournalBatch}.
 */
export async function openBatch(root: string): Promise<JournalBatch> {
  const batchId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const batch: JournalBatch = { batchId, root, status: "pending", entries: [] };
  await persist(batch);
  return batch;
}

/**
 * Record one target's pre-state into the batch and re-persist the journal. Must
 * be called for EVERY target before that target is written, so a crash can
 * always restore the pre-batch world.
 *
 * @param batch - The open pending batch.
 * @param targetPath - Absolute path of the target about to be written.
 */
export async function recordPreState(batch: JournalBatch, targetPath: string): Promise<void> {
  const prior = await readOrNull(targetPath);
  const preState: PreState = prior === null ? ABSENT : { absent: false, content: prior };
  batch.entries.push({ targetPath, preState });
  await persist(batch);
}

/**
 * Mark a batch `committed` and persist it: every write has landed, so the
 * batch's intent is now durable and replay will leave it untouched.
 *
 * @param batch - The batch whose writes have all succeeded.
 */
export async function commitBatch(batch: JournalBatch): Promise<void> {
  batch.status = "committed";
  await persist(batch);
}

/** Revert one target to its recorded pre-state (restore bytes or delete). */
async function revertEntry(entry: JournalEntry): Promise<void> {
  if (entry.preState.absent) {
    try {
      await unlink(entry.targetPath);
    } catch {
      // Already absent — the pre-state is already satisfied.
    }
    return;
  }
  await mkdir(path.dirname(entry.targetPath), { recursive: true });
  await writeFile(entry.targetPath, entry.preState.content, "utf-8");
}

/** Parse a single journal file, returning null on any malformed/unreadable file. */
async function loadBatch(root: string, batchId: string): Promise<JournalBatch | null> {
  const raw = await readOrNull(journalPath(root, batchId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Omit<JournalBatch, "root">;
    return { ...parsed, root };
  } catch {
    return null;
  }
}

/** Revert a pending batch to its full pre-state, then delete its journal file. */
async function resolvePending(batch: JournalBatch): Promise<void> {
  for (const entry of batch.entries) {
    await revertEntry(entry);
  }
  await unlink(journalPath(batch.root, batch.batchId));
}

/**
 * Crash-recovery seam: revert every `pending`-but-not-`committed` batch to its
 * full pre-state, then resolve it. A `committed` batch is left untouched.
 *
 * Idempotent: reverting a pending batch deletes its journal file, so a second
 * call finds no pending batches and does nothing. A missing journal directory
 * is treated as "nothing pending".
 *
 * @param root - Absolute project root whose journal directory is replayed.
 */
export async function replayJournal(root: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(journalDir(root));
  } catch {
    return; // no journal directory → nothing pending
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const batch = await loadBatch(root, file.replace(/\.json$/, ""));
    if (batch !== null && batch.status === "pending") {
      await resolvePending(batch);
    }
  }
}
