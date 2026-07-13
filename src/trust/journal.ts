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

import { open, mkdir, readdir, unlink, rename, type FileHandle } from "fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "path";
import { LLMWIKI_DIR, JOURNAL_PRESTATE_MAX_BYTES } from "../utils/constants.js";
import { realpath } from "fs/promises";
import { confineUnderRoot, safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { readConfinedLeaf, type ReadLeafOptions } from "../utils/confined-read.js";
import { atomicWrite } from "../utils/markdown.js";
import { note } from "../utils/output.js";

/**
 * A mutation target could not be safely captured into the pre-state journal: it
 * exists but is a symlinked leaf (`O_NOFOLLOW` ELOOP), sits under a symlinked
 * PARENT dir that resolves OUTSIDE the project root (or was parent-swapped in a
 * race, caught by the `{dev,ino}` handle binding), is a non-regular file
 * (FIFO/device/directory), or exceeds {@link JOURNAL_PRESTATE_MAX_BYTES}. The
 * whole mutation is REFUSED rather than journaled — coercing this to an `absent`
 * pre-state would make a crash-revert DELETE a target that actually held content
 * (strictly worse than not hardening at all), and capturing an out-of-root leaf
 * reached through a symlinked parent would copy a victim's bytes into the
 * on-disk journal (an info-leak). A symlinked/escaping/non-regular page-or-
 * artifact leaf is never legitimate, so refusing is behavior-preserving for real
 * callers. Modeled on the artifact write path's typed refusal errors.
 */
export class JournalPreStateUnreadableError extends Error {
  constructor(readonly targetPath: string) {
    super(
      `journal pre-state for ${JSON.stringify(targetPath)} is unreadable ` +
        `(symlinked leaf or parent, non-regular, raced, or over ${JOURNAL_PRESTATE_MAX_BYTES} bytes) — refusing the mutation`,
    );
    this.name = "JournalPreStateUnreadableError";
  }
}

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

/**
 * Fail CLOSED (throw) BEFORE opening a batch when `.llmwiki/journal` — or any
 * ancestor, e.g. a symlinked `.llmwiki` — escapes the project root. Confines the
 * journal dir against the nearest existing ancestor via {@link confineUnderRoot},
 * so a planted escaping symlink is rejected up front with a clear error rather
 * than only at persist time. A confined real journal dir resolves cleanly (no-op).
 */
async function assertJournalDirConfined(root: string): Promise<void> {
  // Pass the journal dir RELATIVE to root: confineUnderRoot resolves it against
  // realpath(root), so an absolute path built from a pre-realpath root would be
  // judged outside on a symlinked root (macOS /var → /private/var).
  await confineUnderRoot(path.join(LLMWIKI_DIR, "journal"), root, { mustExist: false });
}

/** Absolute path to a batch's journal file. Exported as a seam for recovery. */
export function journalPath(root: string, batchId: string): string {
  return path.join(journalDir(root), `${batchId}.json`);
}

/** Absolute path a quarantined (untrusted) journal file is moved to. */
function quarantinePath(root: string, batchId: string): string {
  return path.join(journalDir(root), "quarantine", `${batchId}.json`);
}

/**
 * Read a journal storage file's bytes, or `null` when it is absent, a SYMLINKED
 * leaf, or otherwise unreadable. Opened with `O_NOFOLLOW` so a planted
 * `.llmwiki/journal/<id>.json` symlink is not followed out of tree — matching the
 * write side, which persists through the no-follow hardened {@link atomicWrite}.
 * `classifyJournalDir` confines the journal DIR, but that does not confine the LEAF;
 * a followed symlink would let out-of-tree bytes be parsed as a batch and replayed.
 * A refused read yields `null` → the batch is simply not loadable (never replayed).
 */
async function readOrNull(filePath: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    return await handle.readFile("utf-8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Atomically persist a batch's current state to its journal file via the shared
 * hardened {@link atomicWrite} primitive (random O_EXCL temp + rename), so the
 * journal writer inherits the same leaf-symlink write-escape defenses rather than
 * carrying its own bespoke temp+rename.
 */
async function persist(batch: JournalBatch): Promise<void> {
  const file = journalPath(batch.root, batch.batchId);
  const payload = {
    batchId: batch.batchId,
    status: batch.status,
    entries: batch.entries,
  };
  await atomicWrite(file, JSON.stringify(payload, null, 2), { confineRoot: batch.root });
}

/**
 * Open a fresh `pending` batch and persist its (empty) journal file. Targets
 * are recorded one at a time via {@link recordPreState} before any write lands.
 *
 * @param root - Absolute project root the journal hangs off.
 * @returns The opened, persisted {@link JournalBatch}.
 */
export async function openBatch(root: string): Promise<JournalBatch> {
  // FAIL CLOSED UP FRONT on a symlinked `.llmwiki/journal` escaping root, with a
  // clear error, rather than relying solely on the persist-time `confineRoot`
  // (defense in depth). A confined real journal dir is a no-op on the happy path.
  await assertJournalDirConfined(root);
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
 * @param opts - Test-only seam threaded to {@link readConfinedLeaf} so the
 *   parent-swap race can be exercised deterministically (see {@link ReadLeafOptions}).
 */
export async function recordPreState(batch: JournalBatch, targetPath: string, opts: ReadLeafOptions = {}): Promise<void> {
  if (batch.entries.some((entry) => entry.targetPath === targetPath)) {
    return;
  }
  // ROOT-ANCHORED, handle-bound, no-follow capped read: a symlinked leaf, a
  // symlinked PARENT dir (a leaf whose parent resolves OUTSIDE root — the
  // parent-symlink info-leak), a parent-swap race (caught by the {dev,ino}
  // binding), a non-regular target, or one over the cap is `unavailable` and
  // REFUSES the whole mutation. `unavailable` is NEVER coerced to `absent`
  // (which would make a crash-revert DELETE a target that held content); `absent`
  // is ENOENT only.
  const expectedDir = await expectedLeafParentDir(targetPath, batch.root);
  const prior = await readConfinedLeaf(batch.root, targetPath, expectedDir, JOURNAL_PRESTATE_MAX_BYTES, opts);
  if (prior.kind === "unavailable") throw new JournalPreStateUnreadableError(targetPath);
  const preState: PreState = prior.kind === "absent" ? ABSENT : { absent: false, content: prior.body };
  batch.entries.push({ targetPath, preState });
  await persist(batch);
}

/**
 * The LEXICAL expected parent dir for a mutation `targetPath`, expressed under
 * `path.resolve(root)` so {@link readConfinedLeaf}'s `resolveExpectedReal`
 * re-anchors its in-root remainder against `realpath(root)` — the SAME
 * lexical-in-root-join discipline the artifact store's `expectedDir` uses (NOT a
 * realpath'd dir, which would FOLLOW a symlinked parent and defeat the check).
 * The remainder is taken via {@link targetRelativeToRoot}, so this is invariant
 * to which symlink form of root the target was captured under. A target that
 * escapes both root forms keeps its absolute dirname, which then fails the
 * parent-realpath confinement inside `readConfinedLeaf` (fail closed).
 */
async function expectedLeafParentDir(targetPath: string, root: string): Promise<string> {
  const rel = await targetRelativeToRoot(targetPath, root);
  return path.join(path.resolve(root), path.dirname(rel));
}

/**
 * Commit a batch by PRUNING (deleting) its journal file: every write has landed,
 * so the batch needs no recovery. A committed batch carries only stale pre-state
 * copies — replay already skips committed batches and nothing reads them — so at
 * five journalled batches per compile (× repeated watch/refresh) re-persisting
 * `status:"committed"` would accumulate journal files unboundedly. Deleting on
 * commit keeps the journal dir bounded to in-flight (pending) batches only.
 *
 * Crash-safety is unchanged: the last-write→commit window already reverts a
 * fully-written-but-uncommitted batch on replay, and `replayPending` still skips
 * any legacy `committed` file as a defensive guard. The delete is crash-consistent
 * within a running kernel but not power-loss durable (no `fsync`); durability
 * across power loss is future work.
 *
 * @param batch - The batch whose writes have all succeeded.
 */
export async function commitBatch(batch: JournalBatch): Promise<void> {
  batch.status = "committed";
  try {
    await unlink(journalPath(batch.root, batch.batchId));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Re-confine `targetPath` under `root` immediately before acting on it, returning
 * its confined absolute form. Re-confining at action time (not once up front in
 * {@link allTargetsConfined}) closes a TOCTOU window: a parent directory swapped to an
 * escaping symlink AFTER the initial confinement would otherwise let a raw write
 * or delete land outside the project. Throws if the target escapes root.
 */
async function reconfineTarget(targetPath: string, root: string): Promise<string> {
  const rel = await targetRelativeToRoot(targetPath, root);
  return confineUnderRoot(rel, root, { mustExist: false });
}

/** Delete a confined target via a path re-confined at delete time (absent pre-state). */
async function confinedUnlink(targetPath: string, root: string): Promise<void> {
  const confinedPath = await reconfineTarget(targetPath, root);
  try {
    await unlink(confinedPath);
  } catch {
    // Already absent — the pre-state is already satisfied.
  }
}

/**
 * Revert one target to its recorded pre-state (restore prior bytes or delete).
 * Each branch RE-CONFINES `entry.targetPath` under root immediately before
 * acting and routes content through the hardened {@link atomicWrite}
 * (`confineRoot:root`) — never a raw `mkdir`+`writeFile` to a previously-confined
 * path — so a parent-dir swap to an escaping symlink after the replay-time
 * {@link allTargetsConfined} gate can never drive a write/delete outside the
 * project. Exported as an internal seam for {@link recoverJournalBeforeCompile}.
 */
export async function revertEntry(entry: JournalEntry, root: string): Promise<void> {
  if (entry.preState.absent) {
    await confinedUnlink(entry.targetPath, root);
    return;
  }
  const confinedPath = await reconfineTarget(entry.targetPath, root);
  // `confinedPath` is resolved against realpath(root); pass that SAME canonical
  // root form to atomicWrite so its relative-path confine check is invariant to
  // the symlink form root was supplied in (e.g. /var vs /private/var on macOS).
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  await atomicWrite(confinedPath, entry.preState.content, { confineRoot: realRoot });
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

/**
 * Parse a single journal file, returning null on unreadable/malformed/unshaped
 * input. Exported as an internal seam for {@link recoverJournalBeforeCompile}.
 */
export async function loadBatch(root: string, batchId: string): Promise<JournalBatch | null> {
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

/**
 * Remove an untrusted journal file in place via its confined journal path when
 * the quarantine destination cannot be safely confined (the `quarantine/` subdir
 * is a symlink escaping root). The journal is malformed/untrusted anyway; the
 * invariant is NEVER to write or move outside the project root, so we delete it
 * rather than follow the escaping symlink.
 */
async function removeUntrustedInPlace(root: string, batchId: string): Promise<void> {
  try {
    const rel = await targetRelativeToRoot(journalPath(root, batchId), root);
    const confinedJournal = await confineUnderRoot(rel, root, { mustExist: false });
    await unlink(confinedJournal);
  } catch {
    // Journal path itself escapes/cannot be confined — touch nothing outside root.
  }
  note(`⚠ Untrusted journal ${batchId}.json could not be safely quarantined — removed.`);
}

/**
 * Move an untrusted journal file into the quarantine subdir and warn. The
 * destination is confined under root BEFORE any `mkdir`/`rename`, so a symlinked
 * `quarantine/` escaping root can never receive (and thus overwrite) a moved
 * file outside the project. If confinement fails, the journal is removed in
 * place instead via {@link removeUntrustedInPlace}.
 */
async function quarantineBatch(root: string, batchId: string): Promise<void> {
  let dest: string;
  try {
    const rel = await targetRelativeToRoot(quarantinePath(root, batchId), root);
    dest = await confineUnderRoot(rel, root, { mustExist: false });
  } catch {
    await removeUntrustedInPlace(root, batchId);
    return;
  }
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
 * Whole-batch trust gate: confirm EVERY entry's target confines under root,
 * returning false if ANY target escapes (the whole batch is then untrusted).
 * The confined paths are not returned — {@link revertEntry} re-confines each
 * target again at action time to close the confine→act TOCTOU window — this is
 * purely the up-front "is this batch safe to replay at all" check. Exported as
 * an internal seam for {@link recoverJournalBeforeCompile}.
 */
export async function allTargetsConfined(batch: JournalBatch): Promise<boolean> {
  for (const entry of batch.entries) {
    try {
      const rel = await targetRelativeToRoot(entry.targetPath, batch.root);
      await confineUnderRoot(rel, batch.root, { mustExist: false });
    } catch {
      return false; // a target escapes root → untrusted batch
    }
  }
  return true;
}

/**
 * Revert a pending batch to its full pre-state, then delete its journal. Each
 * entry is re-confined at action time inside {@link revertEntry}; the up-front
 * {@link allTargetsConfined} pass remains the whole-batch trust gate (any escaping
 * target quarantines the batch before this runs).
 */
async function resolvePending(batch: JournalBatch): Promise<void> {
  for (const entry of batch.entries) {
    await revertEntry(entry, batch.root);
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
  if (!(await allTargetsConfined(batch))) {
    await quarantineBatch(root, batchId); // a target escapes root
    return;
  }
  await resolvePending(batch);
}

/**
 * The three states a journal directory can be in, as the single shared
 * distinction both the best-effort {@link replayJournal} and the strict
 * {@link recoverJournalBeforeCompile} agree on:
 *  - `absent` — no journal directory (nothing pending);
 *  - `escape` — the directory exists but its realpath leaves root (tampering);
 *  - `ok` — a confined real directory at `dir`, safe to iterate.
 */
export type JournalDirState =
  | { kind: "absent" }
  | { kind: "escape" }
  | { kind: "ok"; dir: string };

/**
 * Classify the journal directory for `root` into {@link JournalDirState}. This
 * is the single place the absent-vs-escape distinction lives so the best-effort
 * replay path and the strict pre-compile recovery path cannot drift apart.
 *
 * @param root - Absolute project root whose journal directory is classified.
 */
export async function classifyJournalDir(root: string): Promise<JournalDirState> {
  const realDir = await safeRealpath(journalDir(root));
  if (realDir === null) return { kind: "absent" };
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  if (!isInsideDir(realDir, realRoot)) return { kind: "escape" };
  return { kind: "ok", dir: realDir };
}

/**
 * Resolve the journal directory's realpath and confirm it stays inside the
 * project root's realpath. Returns the confined real dir to replay, or null to
 * skip: null when the directory is absent (nothing pending) OR when it exists
 * but is a symlink escaping root (filesystem tampering → fail closed). A null
 * caused by escape is announced via {@link note} before returning.
 */
async function resolveConfinedJournalDir(root: string): Promise<string | null> {
  const state = await classifyJournalDir(root);
  if (state.kind === "absent") return null; // nothing pending
  if (state.kind === "escape") {
    note(`⚠ Journal directory escapes project root — refusing to replay (tampering).`);
    return null;
  }
  return state.dir;
}

/**
 * Crash-recovery seam: revert every `pending`-but-not-`committed` batch to its
 * full pre-state, then resolve it. A `committed` batch is left untouched.
 *
 * BEST-EFFORT FAIL CLOSED: a journal file that is unparseable, structurally
 * malformed, or names ANY target that escapes the project root is QUARANTINED
 * (moved under `.llmwiki/journal/quarantine/`) and replay CONTINUES with the
 * remaining batches — so a crafted or corrupted journal can never drive a
 * write/delete outside the root, yet one bad file does not block recovery of the
 * rest. Every surviving target is re-confined under root before it is touched
 * (see {@link revertEntry}). For the STRICTER pre-compile entry point that surfaces
 * any non-revertable condition as `unsafe` instead of quarantining-and-continuing,
 * see {@link recoverJournalBeforeCompile} in `./journal-recovery.ts`.
 *
 * Idempotent: reverting a pending batch deletes its journal file, so a second
 * call finds no pending batches and does nothing. A missing or symlink-escaping
 * journal directory is treated as "nothing safe to replay".
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
  const confinedDir = await resolveConfinedJournalDir(root);
  if (confinedDir === null) return; // absent or escaping → nothing safe to replay
  let files: string[];
  try {
    files = await readdir(confinedDir);
  } catch {
    return; // no journal directory → nothing pending
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    await replayPending(root, file.replace(/\.json$/, ""));
  }
}
