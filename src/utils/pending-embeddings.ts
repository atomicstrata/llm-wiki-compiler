/**
 * @file src/utils/pending-embeddings.ts
 * @description Durable write-ahead "pending embedding refresh" list, as a per-id
 * lifecycle.
 *
 * The compiler flushes source-state to disk (marking every changed source
 * current) and THEN attempts an embeddings refresh that SWALLOWS failures
 * (missing API key, transient provider error, or a crash). Without a durable
 * record, the changed page-ids would then have STALE embeddings while
 * source-state says "up to date" — the next compile detects no source changes
 * and the embeddings are never retried, a silent source↔embeddings disagreement.
 *
 * This module records the page-ids that need an embedding refresh to a durable,
 * root-CONFINED file BEFORE the attempt, and reconciles them AFTER. The compiler
 * DRAINS the list (unions prior-pending ids into the refresh set) on every
 * subsequent non-review compile, so a skipped/crashed refresh is retried even
 * when no source changed.
 *
 * ## Per-id lifecycle (not a flat id list)
 * Each entry is a {@link PendingEmbedding} carrying a FAILED-attempt count, so the
 * marker is a per-id state machine rather than an all-or-nothing batch:
 *  - A page-id that fails for a NON-transient reason (poison id) would otherwise
 *    stay pending forever, re-billed every compile AND wedging the all-or-nothing
 *    batch it shares. After {@link MAX_PENDING_EMBEDDING_ATTEMPTS} failures it is
 *    QUARANTINED (dropped + warned), so it can neither loop nor block healthy ids.
 *  - On SUCCESS only the ids actually re-embedded are cleared. An id that the core
 *    SKIPPED (transiently ineligible: orphaned/untitled/`includeInSearch:false`/
 *    profile-invalid) is RETAINED with an incremented attempt count — never cleared
 *    while un-embedded — until it embeds or ages out. See {@link settleAfterSuccess}.
 * The pure settle/merge/quarantine helpers live here for easy unit-testing.
 *
 * ## Backward-compat
 * A legacy flat `string[]` marker (or array entries that are bare strings) loads as
 * `{ pageId, attempts: 0 }`, so an old on-disk marker is migrated on read rather
 * than discarded. See {@link coerceEntry}.
 *
 * ## Confinement
 * Confinement is enforced at BOTH the dir AND the LEAF — confining only the dir is
 * not enough, because a planted `.llmwiki/pending-embeddings.json` → out-of-tree
 * symlink is a real LEAF that plain `writeFile`/`readFile` would FOLLOW out of tree.
 *
 * The DIR is resolved through the same trust-boundary resolvers the lock uses,
 * NEVER a raw `path.join(root, PENDING_EMBEDDINGS_FILE)` that would follow an
 * escaping `.llmwiki` symlink:
 *  - WRITE ({@link writePendingEmbeddings}) → {@link resolveConfinedPrivateDir}
 *    (mkdir; compile already created `.llmwiki`).
 *  - READ ({@link loadPendingEmbeddings}) / DELETE
 *    ({@link clearPendingEmbeddings}) → {@link resolveExistingConfinedPrivateDir}
 *    (no-mkdir; null on absent/escape).
 *
 * The LEAF is then hardened too:
 *  - WRITE goes through {@link atomicWrite} (`{ confineRoot: <realRoot> }`): a RANDOM
 *    `O_EXCL` temp written through the handle then `rename`d onto the target — rename
 *    REPLACES a leaf instead of following it, where a plain `writeFile` would have
 *    overwritten a symlinked leaf's out-of-tree target. `confineRoot` ADDITIONALLY
 *    fails CLOSED when the leaf itself is a symlink escaping root, so a hostile leaf
 *    is never written through. The `<realRoot>` is `dirname(privateDir)` (the
 *    resolvers return the realpath'd `.llmwiki`), so confine compares
 *    canonical-to-canonical.
 *  - READ opens the leaf with `O_RDONLY | O_NOFOLLOW` (a symlinked leaf → `ELOOP`,
 *    fail open), `fstat`s the HANDLE requiring a REGULAR file, and enforces a
 *    {@link MAX_PENDING_EMBEDDINGS_BYTES} size cap before reading — mirroring
 *    `openGraphFileRead`. The DELETE branch uses `unlink`, which removes the symlink
 *    ITSELF (never its target), so it cannot escape.
 *
 * ## Durability of the write-ahead intent
 * {@link writeMarkerConfined} DISTINGUISHES two failure classes that must not be
 * conflated: a hostile ESCAPING/symlinked leaf (correct to swallow, fail-closed —
 * a hostile leaf must never be written through) versus a genuine I/O failure to
 * persist the write-ahead record (ENOSPC/EIO/EACCES/EROFS — silently swallowing
 * this would VOID the durability guarantee this module claims). The escape is
 * swallowed silently; the I/O failure is SURFACED with a visible warning. Neither
 * throws — embeddings stay non-fatal to compile.
 *
 * The file is under `.llmwiki/`, so it is never emitted into `wiki/` output.
 */

import { unlink, open } from "fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "path";
import {
  PENDING_EMBEDDINGS_FILE,
  MAX_PENDING_EMBEDDINGS_BYTES,
  MAX_PENDING_EMBEDDING_IDS,
  MAX_PENDING_EMBEDDING_ATTEMPTS,
} from "./constants.js";
import * as output from "./output.js";
import { atomicWrite } from "./markdown.js";
import { parseQualifiedPageId } from "./page-id.js";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
} from "./private-dir.js";

/**
 * One pending embedding-refresh entry: a qualified page-id and the count of FAILED
 * refresh attempts so far. `attempts` reaching {@link MAX_PENDING_EMBEDDING_ATTEMPTS}
 * quarantines the id (the poison-id age-out).
 */
export interface PendingEmbedding {
  pageId: string;
  attempts: number;
}

/** Outcome of a settle step: the survivors to write back + the quarantined ids dropped. */
export interface SettleResult {
  survivors: PendingEmbedding[];
  quarantined: PendingEmbedding[];
}

/**
 * Derive the pending-embeddings file path inside an already-confined private dir.
 * SINGLE source of the path derivation, mirroring `lockFileIn` in `lock.ts`.
 */
function pendingFileIn(privateDir: string): string {
  return path.join(privateDir, path.basename(PENDING_EMBEDDINGS_FILE));
}

/**
 * The realpath'd project root that `atomicWrite`'s `confineRoot` must use for the
 * marker leaf. The resolvers return the REALPATH'd `.llmwiki`, so its parent IS the
 * realpath'd root. Mirrors `journal.ts`'s `confineRoot: realRoot` discipline.
 */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
}

/** True for a string that passes the {@link parseQualifiedPageId} grammar gate. */
function isValidPageId(value: unknown): value is string {
  return typeof value === "string" && parseQualifiedPageId(value) !== null;
}

/** A non-negative integer `attempts` value, defaulting to 0 for anything else. */
function toAttempts(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Coerce one parsed array element into a {@link PendingEmbedding}, or `null` if it
 * is not a valid qualified page-id. Migrates the legacy flat schema: a bare string
 * entry loads as `{ pageId, attempts: 0 }`; an object entry takes its non-negative
 * integer `attempts` (defaulting to 0). A forged `"../../etc"` is dropped by the
 * {@link isValidPageId} grammar gate.
 */
function coerceEntry(raw: unknown): PendingEmbedding | null {
  if (typeof raw === "string") {
    return isValidPageId(raw) ? { pageId: raw, attempts: 0 } : null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { pageId, attempts } = raw as { pageId?: unknown; attempts?: unknown };
  if (!isValidPageId(pageId)) return null;
  return { pageId, attempts: toAttempts(attempts) };
}

/**
 * The SINGLE normalization both the writer and reader apply, so a written marker
 * can NEVER be one the reader later discards (the asymmetric-cap bug): coerce each
 * element (migrating legacy strings, dropping non-PageIds), DEDUP by `pageId`
 * keeping the MAX attempts seen, COUNT-cap to {@link MAX_PENDING_EMBEDDING_IDS},
 * then BYTE-cap the serialized JSON to `<= ` {@link MAX_PENDING_EMBEDDINGS_BYTES} by
 * tail-dropping until `JSON.stringify` fits the reader's `fstat` byte cap.
 */
function normalizeMarker(entries: unknown[]): PendingEmbedding[] {
  const deduped = new Map<string, PendingEmbedding>();
  for (const item of entries) {
    const entry = coerceEntry(item);
    if (entry === null) continue;
    const prior = deduped.get(entry.pageId);
    if (prior === undefined) deduped.set(entry.pageId, entry);
    else prior.attempts = Math.max(prior.attempts, entry.attempts);
  }
  let bounded = [...deduped.values()].slice(0, MAX_PENDING_EMBEDDING_IDS);
  while (
    bounded.length > 0 &&
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_PENDING_EMBEDDINGS_BYTES
  ) {
    bounded = bounded.slice(0, -1); // drop tail until the serialized marker fits the read byte cap
  }
  return bounded;
}

/**
 * The structured outcome of parsing the marker bytes, distinguishing the three
 * cases the health-aware read must NOT conflate:
 *  - `ok` → valid JSON that is an ARRAY (possibly EMPTY) → the bounded entries.
 *  - `corrupt` → bytes that are not valid JSON at all (`JSON.parse` threw).
 *  - `schema` → valid JSON whose TOP-LEVEL value is not an array (object/scalar/null):
 *    structurally untrusted, so the marker must be reported as unavailable rather
 *    than silently coerced to empty.
 */
type MarkerParse =
  | { ok: true; entries: PendingEmbedding[] }
  | { ok: false; detail: "corrupt" | "schema" };

/**
 * Parse file bytes into a structured {@link MarkerParse}. A valid JSON ARRAY (even
 * empty) is `ok` and normalized through {@link normalizeMarker} — the EXACT same
 * bound the writer applies, so read and write share one bound; valid-JSON-wrong-shape
 * is `schema` (untrusted) and unparseable JSON is `corrupt`. The marker is
 * sync/attacker-controllable, so this re-validates and re-bounds defensively and
 * never fails open on a non-array.
 *
 * An EMPTY array `[]` stays `ok` with zero entries — it genuinely means "no pending,"
 * NOT "untrusted." Only a NON-array top-level value is rejected as `schema`.
 */
function parseMarker(raw: string): MarkerParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: "corrupt" };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: "schema" };
  return { ok: true, entries: normalizeMarker(parsed) };
}

/**
 * The trust state of an attempted marker read, distinguishing the cases
 * {@link readMarkerCapped} must NOT conflate:
 *  - `absent` → the leaf does not exist (`open` ENOENT). A clean project; not a
 *    fault.
 *  - `unreadable` → the leaf EXISTS but cannot be trusted: a symlinked leaf
 *    (`ELOOP`), a non-regular file, or one over {@link MAX_PENDING_EMBEDDINGS_BYTES}.
 *    Recovery data may be silently lost — surface it, never report it as clean.
 *  - `ok` → a regular, in-cap leaf was read into `body`.
 */
type MarkerRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "ok"; body: string };

/**
 * Open the marker leaf with `O_RDONLY | O_NOFOLLOW`, `fstat` the HANDLE, and read
 * its bytes — returning a DISCRIMINATED {@link MarkerRead} so the caller can tell
 * ABSENT (open ENOENT) apart from UNREADABLE (a symlinked leaf `ELOOP`, a
 * non-regular file, or one larger than {@link MAX_PENDING_EMBEDDINGS_BYTES}).
 * Conflating the two would report an unreadable recovery marker as clean. Mirrors
 * `openGraphFileRead`.
 */
async function readMarkerCapped(filePath: string): Promise<MarkerRead> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    // ENOENT → genuinely absent; a symlinked leaf throws ELOOP → exists-but-untrusted.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PENDING_EMBEDDINGS_BYTES) return { kind: "unreadable" };
    return { kind: "ok", body: await handle.readFile("utf-8") };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The trust-aware result of reading the pending marker, distinguishing "no marker
 * exists" (clean) from "marker exists but cannot be trusted" (silent recovery-data
 * loss). `detail` describes WHY a marker is `unavailable` (`escape`/`corrupt`/the
 * leaf-read reason) so the surface can name it.
 */
export interface PendingMarkerRead {
  status: "absent" | "ok" | "unavailable";
  entries: PendingEmbedding[];
  detail?: string;
}

/**
 * Read the pending marker into a STRUCTURED, trust-aware result — the single source
 * both the fail-open drain ({@link loadPendingEmbeddings}) and the warning mapper
 * use, so they agree on whether a marker is clean, present, or untrustworthy:
 *  - resolver escape (an escaping `.llmwiki`) → `unavailable` (`escape`).
 *  - private dir absent OR leaf ENOENT → `absent`.
 *  - symlinked / oversize / non-regular leaf → `unavailable` (the leaf-read reason).
 *  - corrupt JSON (unparseable bytes) → `unavailable` (`corrupt`).
 *  - schema-invalid JSON (valid JSON, non-array top level) → `unavailable` (`schema`).
 *  - otherwise (a valid array, possibly empty) → `ok` with the bounded entries.
 *
 * @param root - Absolute project root.
 */
export async function readPendingMarker(root: string): Promise<PendingMarkerRead> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { status: "unavailable", entries: [], detail: "escape" };
  }
  if (privateDir === null) return { status: "absent", entries: [] };
  const read = await readMarkerCapped(pendingFileIn(privateDir));
  if (read.kind === "absent") return { status: "absent", entries: [] };
  if (read.kind === "unreadable") return { status: "unavailable", entries: [], detail: "unreadable" };
  const result = parseMarker(read.body);
  if (!result.ok) return { status: "unavailable", entries: [], detail: result.detail };
  return { status: "ok", entries: result.entries };
}

/**
 * Load the per-id pending embedding-refresh entries — a thin, FAIL-OPEN wrapper over
 * {@link readPendingMarker} that returns its `.entries` (always `[]` for both
 * `absent` AND `unavailable`). The drain stays non-fatal: a bad marker never breaks
 * a compile, and the write-ahead record then OVERWRITES the corrupt marker with the
 * fresh set (self-healing). Callers that must DISTINGUISH absent from unavailable
 * (the warning surface) use {@link readPendingMarker} directly.
 *
 * @param root - Absolute project root.
 * @returns The valid, bounded pending entries; `[]` on absent/escape/oversize/corrupt.
 */
export async function loadPendingEmbeddings(root: string): Promise<PendingEmbedding[]> {
  return (await readPendingMarker(root)).entries;
}

/**
 * UNION fresh page-ids into a prior pending set, PRIORITY-ORDERED so the current
 * compile's just-failed changed ids survive the marker caps.
 *
 * The FRESH ids (this run's changes — exactly the work the write-ahead marker
 * exists to make durable) come FIRST as a priority partition; the prior-only
 * backlog fills the REMAINING space after them. Because {@link normalizeMarker}
 * keeps the HEAD for the count cap and tail-drops for the byte cap, this ordering
 * makes both caps shed the OLDEST backlog rather than crowding out the current
 * changes (the bug where a full backlog of old ids dropped the fresh ones).
 *
 * Each id is `{ attempts: 0 }` unless it was ALREADY pending, in which case it
 * carries its accumulated attempt count forward (a re-changed poison id keeps its
 * age-out progress) — but it still sits in the FRESH partition because it is a
 * current change. The fresh ids are deduped among themselves. Pure — easy to test.
 */
export function mergeFreshAttempts(prior: PendingEmbedding[], freshIds: string[]): PendingEmbedding[] {
  const priorById = new Map(prior.map((e) => [e.pageId, e] as const));
  const merged = new Map<string, PendingEmbedding>();
  for (const pageId of freshIds) {
    if (merged.has(pageId)) continue; // dedup the fresh ids among themselves
    merged.set(pageId, priorById.get(pageId) ?? { pageId, attempts: 0 }); // carry prior attempts
  }
  for (const entry of prior) {
    if (!merged.has(entry.pageId)) merged.set(entry.pageId, entry); // backlog fills remaining space
  }
  return [...merged.values()];
}

/**
 * Settle the marker after a SUCCESSFUL (all-or-nothing) refresh, keyed off the
 * core's report of what it actually embedded vs the eligible universe:
 *  - `embedded` → done, removed.
 *  - in `eligible` but NOT embedded (unusual) → kept UNCHANGED (still live).
 *  - NOT in `eligible` (ineligible OR deleted) → cannot embed as-is → attempts++;
 *    QUARANTINE at the cap so a permanently-ineligible id ages out rather than
 *    being cleared un-embedded (the silent-never-re-queue bug) or lingering forever.
 * Pure — returns survivors to write back + the quarantined entries to warn on.
 */
export function settleAfterSuccess(
  merged: PendingEmbedding[],
  embedded: string[],
  eligible: string[],
): SettleResult {
  const embeddedSet = new Set(embedded);
  const eligibleSet = new Set(eligible);
  const survivors: PendingEmbedding[] = [];
  const quarantined: PendingEmbedding[] = [];
  for (const entry of merged) {
    if (embeddedSet.has(entry.pageId)) continue; // embedded → clear
    if (eligibleSet.has(entry.pageId)) { survivors.push(entry); continue; } // live, retry as-is
    bumpOrQuarantine(entry, survivors, quarantined); // ineligible/deleted → age out
  }
  return { survivors, quarantined };
}

/**
 * Settle the marker after a FAILED (thrown) refresh: the whole all-or-nothing batch
 * failed, so increment attempts for EVERY id in the batch and QUARANTINE those over
 * the cap — so a poison id that throws (non-transient provider error / integrity
 * error) stops wedging the batch on the next compile instead of looping forever.
 * Pure — returns survivors + quarantined.
 */
export function settleAfterFailure(merged: PendingEmbedding[], toRefresh: string[]): SettleResult {
  const inBatch = new Set(toRefresh);
  const survivors: PendingEmbedding[] = [];
  const quarantined: PendingEmbedding[] = [];
  for (const entry of merged) {
    if (!inBatch.has(entry.pageId)) { survivors.push(entry); continue; }
    bumpOrQuarantine(entry, survivors, quarantined);
  }
  return { survivors, quarantined };
}

/**
 * Increment one entry's failed-attempt count, then route it: under the cap →
 * survivors (retry next compile); at/over the cap → quarantined (age out). Shared by
 * both settle paths so the age-out rule lives in ONE place.
 */
function bumpOrQuarantine(
  entry: PendingEmbedding,
  survivors: PendingEmbedding[],
  quarantined: PendingEmbedding[],
): void {
  const bumped: PendingEmbedding = { pageId: entry.pageId, attempts: entry.attempts + 1 };
  if (bumped.attempts >= MAX_PENDING_EMBEDDING_ATTEMPTS) quarantined.push(bumped);
  else survivors.push(bumped);
}

/**
 * Emit a VISIBLE warning naming each quarantined page-id + its attempt count, so a
 * poison id is NEVER silently discarded. Routed through the shared output/warn path
 * (not raw console). No-op when nothing was quarantined.
 */
export function warnQuarantined(quarantined: PendingEmbedding[]): void {
  for (const entry of quarantined) {
    output.status(
      "!",
      output.warn(
        `Quarantined pending embedding for ${entry.pageId} after ${entry.attempts} failed refresh attempt(s); ` +
          `it will not be retried. Re-save or edit the source to re-queue it.`,
      ),
    );
  }
}

/**
 * Persist the pending list, REPLACING the marker with `entries` (the caller already
 * computed the full set; this is not a union). When `entries` is empty the file is
 * DELETED. Normalizes through {@link normalizeMarker} so the write can never emit a
 * marker the next {@link loadPendingEmbeddings} would discard. Resolves via the
 * write resolver and FAILS CLOSED on an escaping `.llmwiki` (best-effort retry hint).
 *
 * @param root - Absolute project root.
 * @param entries - The full pending set to persist.
 */
export async function writePendingEmbeddings(root: string, entries: PendingEmbedding[]): Promise<void> {
  const normalized = normalizeMarker(entries);
  if (normalized.length === 0) {
    await clearPendingEmbeddings(root);
    return;
  }
  let privateDir: string;
  try {
    // FAIL CLOSED like `acquireLock`: a `.llmwiki` (or ancestor) that symlinks
    // outside the root makes the write resolver throw, so the marker is NEVER
    // created out-of-tree. Swallow the escape rather than break compile.
    privateDir = await resolveConfinedPrivateDir(root);
  } catch {
    return;
  }
  await writeMarkerConfined(privateDir, JSON.stringify(normalized));
}

/**
 * Distinguish the two write-failure classes that must NOT be conflated. The leaf
 * goes through the hardened {@link atomicWrite} (random `O_EXCL` temp → `rename`,
 * which REPLACES a symlinked leaf; `confineRoot` ALSO fails closed if the leaf
 * escapes root):
 *  - an ESCAPING/symlinked-leaf confinement error is swallowed SILENTLY (fail-closed
 *    — a hostile leaf must never be written through), and
 *  - a genuine I/O failure (ENOSPC/EIO/EACCES/EROFS — an errno {@link isIoFailure})
 *    is SURFACED with a single visible warning, because silently swallowing it would
 *    VOID the write-ahead durability guarantee this module claims.
 * Neither throws — embeddings stay non-fatal to compile.
 */
async function writeMarkerConfined(privateDir: string, body: string): Promise<void> {
  try {
    await atomicWrite(pendingFileIn(privateDir), body, { confineRoot: realRootOf(privateDir) });
  } catch (err) {
    if (isIoFailure(err)) {
      output.status(
        "!",
        output.warn(
          "Could not persist the pending-embeddings retry marker (write failed); a skipped " +
            "embeddings refresh may not be retried until the next source change.",
        ),
      );
    }
    // else: escaping/symlinked leaf — fail closed, swallow silently (never write a hostile leaf).
  }
}

/**
 * True for a genuine I/O write failure (an errno-bearing `NodeJS.ErrnoException`,
 * e.g. ENOSPC/EIO/EACCES/EROFS) — as opposed to a confinement/escape error, which
 * the atomicWrite layer throws as a plain `Error` with no `.code`. The presence of
 * a string errno `code` is the discriminator.
 */
function isIoFailure(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === "string";
}

/**
 * Delete the marker entirely (best-effort, ENOENT swallowed). Uses the no-mkdir
 * resolver and is a no-op when `.llmwiki` is absent or escapes — clearing what
 * isn't there is harmless. `unlink` removes the symlink ITSELF (never its target),
 * so it cannot escape.
 *
 * @param root - Absolute project root.
 */
export async function clearPendingEmbeddings(root: string): Promise<void> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return; // escaping `.llmwiki` — nothing safe to clear
  }
  if (privateDir === null) return; // .llmwiki absent → nothing to clear
  await unlink(pendingFileIn(privateDir)).catch(() => {}); // already gone — best-effort
}
