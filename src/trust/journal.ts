/**
 * @file src/trust/journal.ts
 * @description The single-store INTENT JOURNAL for the PAGE store — the
 * crash-recovery record that realizes the CLP atomicity contract: "partial
 * application of an approved mutation batch is a bug." The write-temp-then-rename
 * idiom used here is crash-consistent within a single running kernel (a torn
 * batch replays cleanly), but it is NOT power-loss durable: there is no `fsync`,
 * so an unflushed rename can be lost on power failure. Durability across power
 * loss is future work.
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
import { realpath } from "fs/promises";
import { confineUnderRoot } from "../utils/path-confine.js";
import { note } from "../utils/output.js";

/** Sentinel recorded when a target did not exist before the batch. */
const ABSENT = { absent: true } as const;

/** How many base-36 random characters to append to a batch id for uniqueness. */
const BATCH_ID_RANDOM_CHARS = 6;

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

/** Absolute path a quarantined (untrusted) journal file is moved to. */
function quarantinePath(root: string, batchId: string): string {
  return path.join(journalDir(root), "quarantine", `${batchId}.json`);
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
  const random = Math.random().toString(36).slice(2, 2 + BATCH_ID_RANDOM_CHARS);
  const batchId = `${Date.now()}-${process.pid}-${random}`;
  const batch: JournalBatch = { batchId, root, status: "pending", entries: [] };
  await persist(batch);
  return batch;
}

/**
 * Record one target's pre-state into the batch and re-persist the journal. Must
 * be called for EVERY target before that target is written, so a crash can
 * always restore the pre-batch world.
 *
 * De-duplicated per DISTINCT target path: the FIRST observation of a path (the
 * true pre-batch state, captured before any write in this batch) is the one
 * kept. A second call for the same path is a no-op, so two mutations to one
 * target cannot record a mid-batch post-state that revert would restore.
 *
 * @param batch - The open pending batch.
 * @param targetPath - Absolute path of the target about to be written.
 */
export async function recordPreState(batch: JournalBatch, targetPath: string): Promise<void> {
  if (batch.entries.some((entry) => entry.targetPath === targetPath)) {
    return;
  }
  const prior = await readOrNull(targetPath);
  const preState: PreState = prior === null ? ABSENT : { absent: false, content: prior };
  batch.entries.push({ targetPath, preState });
  await persist(batch);
}

/**
 * Mark a batch `committed` and persist it: every write has landed, so replay
 * will leave it untouched. The persisted commit is crash-consistent within a
 * running kernel but not power-loss durable (no `fsync`); durability across
 * power loss is future work.
 *
 * @param batch - The batch whose writes have all succeeded.
 */
export async function commitBatch(batch: JournalBatch): Promise<void> {
  batch.status = "committed";
  await persist(batch);
}

/**
 * Revert one target to its recorded pre-state (restore bytes or delete), writing
 * to `confinedPath` — the result of re-confining `entry.targetPath` under root,
 * so replay can never act on a path that escapes the project.
 */
async function revertEntry(entry: JournalEntry, confinedPath: string): Promise<void> {
  if (entry.preState.absent) {
    try {
      await unlink(confinedPath);
    } catch {
      // Already absent — the pre-state is already satisfied.
    }
    return;
  }
  await mkdir(path.dirname(confinedPath), { recursive: true });
  await writeFile(confinedPath, entry.preState.content, "utf-8");
}

/** Validate one parsed entry has a string `targetPath` and a well-formed `preState`. */
function isValidEntry(entry: unknown): entry is JournalEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const { targetPath, preState } = entry as Record<string, unknown>;
  if (typeof targetPath !== "string") return false;
  if (typeof preState !== "object" || preState === null) return false;
  const { absent, content } = preState as Record<string, unknown>;
  if (absent === true) return content === undefined;
  return absent === false && typeof content === "string";
}

/**
 * Validate a parsed journal payload is a well-formed batch: a `status` of
 * `"pending"`/`"committed"` and an `entries` array of valid entries. A malformed
 * payload is untrusted and must NOT be replayed.
 */
function isValidBatchShape(parsed: unknown): parsed is Omit<JournalBatch, "root"> {
  if (typeof parsed !== "object" || parsed === null) return false;
  const { status, entries } = parsed as Record<string, unknown>;
  if (status !== "pending" && status !== "committed") return false;
  return Array.isArray(entries) && entries.every(isValidEntry);
}

/** Parse a single journal file, returning null on unreadable/malformed/unshaped input. */
async function loadBatch(root: string, batchId: string): Promise<JournalBatch | null> {
  const raw = await readOrNull(journalPath(root, batchId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidBatchShape(parsed)) return null;
  return { ...parsed, root };
}

/** Move an untrusted journal file into the quarantine subdir and warn. */
async function quarantineBatch(root: string, batchId: string): Promise<void> {
  const dest = quarantinePath(root, batchId);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(journalPath(root, batchId), dest);
  note(`⚠ Untrusted journal ${batchId}.json quarantined to ${dest} — not replayed.`);
}

/**
 * Express `targetPath` relative to `root` so confinement is invariant to which
 * symlink form of root it was recorded under (e.g. `/var/...` vs the canonical
 * `/private/var/...` on macOS). An absolute target under either the literal or
 * the realpath'd root is reduced to its in-root remainder; a target that lies
 * outside both forms is returned unchanged so {@link confineUnderRoot} rejects it.
 */
async function targetRelativeToRoot(targetPath: string, root: string): Promise<string> {
  if (!path.isAbsolute(targetPath)) return targetPath;
  const realRoot = (await realpath(root).catch(() => null)) ?? path.resolve(root);
  for (const base of [path.resolve(root), realRoot]) {
    const rel = path.relative(base, targetPath);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return targetPath;
}

/**
 * Re-confine every entry's target under root, returning the confined absolute
 * paths in entry order, or null if ANY target escapes root (whole batch untrusted).
 */
async function confineTargets(batch: JournalBatch): Promise<string[] | null> {
  const confined: string[] = [];
  for (const entry of batch.entries) {
    try {
      const rel = await targetRelativeToRoot(entry.targetPath, batch.root);
      confined.push(await confineUnderRoot(rel, batch.root, { mustExist: false }));
    } catch {
      return null; // a target escapes root → untrusted batch
    }
  }
  return confined;
}

/** Revert a pending batch to its full pre-state (confined paths), then delete its journal. */
async function resolvePending(batch: JournalBatch, confinedPaths: string[]): Promise<void> {
  for (let i = 0; i < batch.entries.length; i++) {
    await revertEntry(batch.entries[i], confinedPaths[i]);
  }
  await unlink(journalPath(batch.root, batch.batchId));
}

/** Replay (or quarantine) one pending batch loaded from `batchId`. */
async function replayPending(root: string, batchId: string): Promise<void> {
  const batch = await loadBatch(root, batchId);
  if (batch === null) {
    await quarantineBatch(root, batchId); // unreadable JSON or malformed shape
    return;
  }
  if (batch.status !== "pending") return; // committed → leave untouched
  const confinedPaths = await confineTargets(batch);
  if (confinedPaths === null) {
    await quarantineBatch(root, batchId); // a target escapes root
    return;
  }
  await resolvePending(batch, confinedPaths);
}

/**
 * Crash-recovery seam: revert every `pending`-but-not-`committed` batch to its
 * full pre-state, then resolve it. A `committed` batch is left untouched.
 *
 * FAIL CLOSED: a journal file that is unparseable, structurally malformed, or
 * names ANY target that escapes the project root is QUARANTINED (moved under
 * `.llmwiki/journal/quarantine/`) and never replayed — so a crafted or corrupted
 * journal can never drive a write/delete outside the root. Every surviving target
 * is re-confined via {@link confineUnderRoot} before it is touched.
 *
 * Idempotent: reverting a pending batch deletes its journal file, so a second
 * call finds no pending batches and does nothing. A missing journal directory
 * is treated as "nothing pending".
 *
 * LOCKING: this function does NOT acquire the project lock — the CALLER must
 * already hold it so replay runs under the same mutual exclusion as the batch it
 * recovers (see {@link applyApprovedMutations}, which calls replay under the
 * held lock). A future standalone startup hook must acquire the lock itself
 * before calling this.
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
    await replayPending(root, file.replace(/\.json$/, ""));
  }
}
