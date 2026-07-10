/**
 * @file src/workflows/store.ts
 * @description Confined CRUD primitives for durable workflow run records.
 *
 * Each run is one JSON file at `.llmwiki/workflows/runs/<runId>.json` — a private
 * dir, never emitted into `wiki/` output. This module mints run ids, writes,
 * reads, lists, and resolves run records. It performs NO execution and owns NO
 * status transitions; it is purely the durable store.
 *
 * ## Confinement
 * Confinement is enforced at BOTH the DIR and the LEAF, and no UNVALIDATED run id
 * ever reaches the filesystem. The `runId` is the only path component this module
 * interpolates, and it is gated through {@link isSlugSafe} (`^[a-z0-9][a-z0-9-]*$`,
 * so it can contain no `/` or `.`) on EVERY path — write, read, list, and resolve —
 * before any fs call.
 *
 *  - The DIR is resolved through the same trust-boundary resolvers the lock uses,
 *    never a raw `path.join(root, ...)` that would follow an escaping `.llmwiki`
 *    symlink: WRITE → {@link resolveConfinedPrivateDir} (mkdir + post-mkdir realpath
 *    recheck); READ/LIST → {@link resolveExistingConfinedPrivateDir} (no-mkdir, null
 *    on absent, throws on escape). The intermediate `workflows/runs` subdir is then
 *    re-confined inside the private dir on BOTH paths — WRITE via `ensureRunsDir`
 *    (post-mkdir realpath recheck), READ/LIST via `existingRunsDir` (realpath the
 *    subdir, fail closed unless it stays inside the private dir). This matters
 *    because `O_NOFOLLOW` rejects only a symlinked FINAL leaf; it does NOT stop
 *    traversal through a symlinked INTERMEDIATE dir (a planted
 *    `.llmwiki/workflows` → out-of-tree symlink), so the subdir realpath recheck is
 *    the actual escape guard there.
 *  - The LEAF is hardened too. WRITE goes through {@link atomicWrite}
 *    (`{ confineRoot: <realRoot> }`): a random `O_EXCL` temp → `rename`, which
 *    REPLACES a leaf instead of following it, and `confineRoot` ADDITIONALLY fails
 *    closed when the leaf escapes root, so a planted symlinked leaf is never written
 *    through. READ opens the leaf — UNDER the realpath-confirmed runs dir — with
 *    `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (a symlinked leaf → `ELOOP`, reported
 *    `unavailable`; `O_NONBLOCK` stops a planted FIFO from BLOCKING the open
 *    forever — a local DoS), `fstat`s the HANDLE requiring a REGULAR file, and enforces
 *    {@link MAX_WORKFLOW_RUN_BYTES} before reading (leaf-level defense in depth).
 *
 * ## Fail-closed reads
 * A read returns a discriminated {@link WorkflowRunRead}. It is `unavailable` (never
 * a partially-trusted record, never out-of-tree bytes) on: bad id, resolver escape,
 * symlinked/oversize/non-regular leaf, corrupt JSON, a `schemaVersion` greater than
 * {@link WORKFLOW_RUN_SCHEMA_VERSION} (surfaced, NOT auto-repaired), a structurally
 * unsigned pre-HMAC v1 record (`legacy-unsigned` — shape-migrated but never auto-
 * trusted), an in-JSON `runId` that disagrees with the filename stem, or a failed
 * shape check. A missing leaf is `absent` (a clean run id, not a fault).
 */

import { readdir, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MAX_WORKFLOW_RUN_BYTES, MAX_MINT_ATTEMPTS } from "../utils/constants.js";
import { atomicWrite } from "../utils/markdown.js";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { isSlugSafe } from "../profile/identity.js";
import { appendTerminalEvent } from "./events.js";
import { migrateRun } from "./run-migrate.js";
import { hasValidRunShape, hasMonotonicVersionChain } from "./run-validate.js";
import { loadOrCreateRunKey, loadRunKey, runIntegrity, integrityMatches } from "./integrity.js";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
} from "../utils/private-dir.js";
import {
  WORKFLOW_RUN_SCHEMA_VERSION,
  RUN_INTEGRITY_MIN_SCHEMA_VERSION,
  type WorkflowEvent,
  type WorkflowRun,
} from "./types.js";

/**
 * Number of random bytes whose hex suffixes a minted run id. 8 bytes → a 16-hex
 * suffix (64 bits of entropy), so a same-day birthday collision is negligible
 * even at very high run volumes. (A prior value of 2 → 16 bits made a collision —
 * which, without the no-clobber start, would OVERWRITE prior run history —
 * realistic at hundreds of runs/day.)
 */
const RUN_ID_RANDOM_BYTES = 8;

/**
 * Hard upper bound on a run id's length. The shared {@link isSlugSafe} grammar
 * caps charset but NOT length, so a multi-thousand-char all-lowercase id passes
 * it and then dies with a generic `ENAMETOOLONG` deep inside `writeRun`. This
 * store-local bound rejects an over-long id with a TYPED outcome (write →
 * {@link WorkflowRunIdError}; read → `unavailable`) BEFORE any fs call. 128 is far
 * above a minted id (`<workflowId>-<YYYY-MM-DD>-<rand4>`) yet well under any
 * filesystem `NAME_MAX`. `isSlugSafe` is left untouched (it is shared across many
 * surfaces); the length bound lives only where filenames are minted.
 */
const MAX_RUN_ID_LENGTH = 128;

/** True only when `runId` is slug-safe AND within {@link MAX_RUN_ID_LENGTH}. */
function isValidRunId(runId: string): boolean {
  return runId.length <= MAX_RUN_ID_LENGTH && isSlugSafe(runId);
}

/** Subdirectory under `.llmwiki` holding per-run record files. */
const RUNS_SUBDIR = ["workflows", "runs"] as const;

/**
 * Raised when a run id that should already be slug-safe is not, on the WRITE
 * path. A typed error (not a generic `Error`) so callers can catch it distinctly.
 * The profile validator already rejects non-slug-safe workflow ids, so this is a
 * defensive last line.
 */
export class WorkflowRunIdError extends Error {
  constructor(message: string) {
    super(`workflow run id rejected: ${message}`);
    this.name = "WorkflowRunIdError";
  }
}

/**
 * Raised when a serialized run record would exceed {@link MAX_WORKFLOW_RUN_BYTES}
 * on the WRITE path. `readRun` rejects an oversize file, so writing one would
 * brick the run (unreadable forever); this fails the write CLOSED instead, with a
 * typed error callers can branch on. Thrown by {@link serializeRunWithinCap}
 * (used by `writeRun` and the stage-output preflight).
 */
export class WorkflowRunTooLargeError extends Error {
  constructor(
    /** The serialized record's byte length that breached the cap. */
    readonly bytes: number,
  ) {
    super(`workflow run record is too large: ${bytes} bytes exceeds the cap of ${MAX_WORKFLOW_RUN_BYTES}`);
    this.name = "WorkflowRunTooLargeError";
  }
}

/**
 * Raised when {@link startWorkflow}'s no-clobber create keeps colliding with an
 * existing run id past {@link MAX_MINT_ATTEMPTS}. Astronomically unlikely with the
 * minted entropy; a typed error so a pathological environment surfaces rather than
 * looping or silently overwriting prior run history.
 */
export class WorkflowRunIdCollisionError extends Error {
  constructor(attempts: number) {
    super(`could not mint a non-colliding workflow run id after ${attempts} attempts`);
    this.name = "WorkflowRunIdCollisionError";
  }
}

/**
 * Serialize a run record to its on-disk JSON, FAILING CLOSED with
 * {@link WorkflowRunTooLargeError} when the result exceeds
 * {@link MAX_WORKFLOW_RUN_BYTES}. This is the SINGLE place run bytes are sized, so
 * the writer and the reader agree on the same ceiling — a record that serializes
 * within the cap here is guaranteed readable by {@link readRun} (which rejects an
 * oversize leaf), closing the asymmetric-cap (write-unbounded / read-capped) gap.
 *
 * @param run - The run record to serialize.
 * @returns The serialized JSON, guaranteed within the byte cap.
 * @throws {WorkflowRunTooLargeError} When the serialized record exceeds the cap.
 */
export function serializeRunWithinCap(run: WorkflowRun): string {
  const json = JSON.stringify(run);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_WORKFLOW_RUN_BYTES) throw new WorkflowRunTooLargeError(bytes);
  return json;
}

/** The trust-aware result of reading a single run record. */
export type WorkflowRunRead =
  | { status: "ok"; run: WorkflowRun }
  | { status: "absent" }
  | { status: "unavailable"; detail: string };

/** The `workflows/runs` directory inside an already-confined private dir. */
function runsDirFor(privateDir: string): string {
  return path.join(privateDir, ...RUNS_SUBDIR);
}

/** Outcome of confining the runs dir on a READ/LIST path. */
type RunsDirResolution =
  | { kind: "ok"; dir: string }
  | { kind: "absent" }
  | { kind: "escape" };

/**
 * Confine the `workflows/runs` dir on the READ path. `O_NOFOLLOW` only rejects a
 * symlinked FINAL leaf — it does NOT stop traversal through a symlinked
 * INTERMEDIATE dir (a `.llmwiki/workflows` → out-of-tree symlink). So this
 * realpaths the runs dir and FAILS CLOSED unless that realpath still sits inside
 * the confined private dir, mirroring the write path's `ensureRunsDir` recheck.
 * Distinguishes a genuinely-absent dir (ENOENT) from a symlink-escape so the
 * caller can report the escape as `unavailable` rather than a clean `absent`.
 */
async function existingRunsDir(privateDir: string): Promise<RunsDirResolution> {
  const runsDir = runsDirFor(privateDir);
  const realRuns = await safeRealpath(runsDir);
  if (realRuns === null) return { kind: "absent" }; // dir does not exist yet
  if (!isInsideDir(realRuns, privateDir)) return { kind: "escape" };
  return { kind: "ok", dir: realRuns };
}

/**
 * The realpath'd project root that `atomicWrite`'s `confineRoot` must use. The
 * resolvers return the REALPATH'd `.llmwiki`, so its parent IS the realpath'd root.
 */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
}

/**
 * Mint an opaque, slug-safe run id of the form `<workflowId>-<YYYY-MM-DD>-<rand>`.
 *
 * The date is today's `toISOString().slice(0,10)` and `rand` is the hex of
 * {@link RUN_ID_RANDOM_BYTES} random bytes from `node:crypto` (a 16-hex suffix).
 * Date/randomness are fine here — this is product code, not a workflow script. The
 * result is asserted slug-safe before returning; a non-slug-safe `workflowId`
 * cannot legitimately reach here (the profile validator rejects it) but the
 * assertion is a defensive floor.
 *
 * @param workflowId - The slug-safe id of the workflow being run.
 * @returns A slug-safe run id prefixed with `workflowId`.
 * @throws {WorkflowRunIdError} If the composed id is not slug-safe.
 */
export function mintRunId(workflowId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(RUN_ID_RANDOM_BYTES).toString("hex");
  const runId = `${workflowId}-${date}-${rand}`;
  if (!isSlugSafe(runId)) {
    throw new WorkflowRunIdError(`composed id is not slug-safe: ${JSON.stringify(runId)}`);
  }
  return runId;
}

/**
 * True when a run record already exists at `<runId>.json`. A no-clobber START
 * uses this (under the project lock the caller already holds, so check-then-write
 * is race-free against other lock holders) to refuse overwriting prior run
 * history. An `unavailable` read (a tampered/symlinked leaf at that id) ALSO
 * counts as present — fail closed, never clobber what we cannot vouch for.
 *
 * @param root - Absolute project root.
 * @param runId - The candidate run id to probe.
 * @returns `true` when a record exists or is unreadable at that id, `false` only
 *   when the read is cleanly `absent`.
 */
export async function runExists(root: string, runId: string): Promise<boolean> {
  return (await readRun(root, runId)).status !== "absent";
}

/**
 * Build and confine the `workflows/runs` dir under an already-confined private
 * dir: mkdir recursive, then re-confine via the WRITE resolver's recheck so a
 * swapped-in symlink escaping the private dir fails closed.
 */
async function ensureRunsDir(privateDir: string): Promise<string> {
  const runsDir = runsDirFor(privateDir);
  await mkdir(runsDir, { recursive: true });
  const realRuns = await safeRealpath(runsDir);
  if (realRuns === null || !isInsideDir(realRuns, privateDir)) {
    throw new WorkflowRunIdError("runs dir escapes the private dir");
  }
  return runsDir;
}

/**
 * Persist a run record to `.llmwiki/workflows/runs/<runId>.json`.
 *
 * Re-asserts the run id is slug-safe (the only interpolated path component),
 * resolves and confines the private dir + runs subdir, then atomic-writes the
 * serialized record through {@link atomicWrite} with `confineRoot` so a symlinked
 * leaf is never written through.
 *
 * The serialized record is SIZE-CHECKED via {@link serializeRunWithinCap} BEFORE
 * any fs call, so a record that would breach {@link MAX_WORKFLOW_RUN_BYTES} (and
 * thus be rejected forever by {@link readRun}) fails the write CLOSED rather than
 * bricking the run.
 *
 * @param root - Absolute project root.
 * @param run - The run record to persist (its `runId` is the filename stem).
 * @throws {WorkflowRunIdError} If `run.runId` is not slug-safe.
 * @throws {WorkflowRunTooLargeError} If the serialized record exceeds the byte cap.
 */
export async function writeRun(root: string, run: WorkflowRun): Promise<void> {
  if (!isValidRunId(run.runId)) {
    throw new WorkflowRunIdError(`not slug-safe or too long: ${JSON.stringify(run.runId.slice(0, 64))}`);
  }
  const stamped = await stampRunIntegrity(root, run);
  const json = serializeRunWithinCap(stamped);
  await persistRunJson(root, stamped.runId, json);
}

/**
 * Return a copy of `run` carrying a fresh `integrity` HMAC over its content (the
 * record with `integrity` itself omitted), computed under the per-project
 * {@link loadOrCreateRunKey}. STAMPED on every write so {@link readRun} can re-verify
 * it; a record not produced by THIS project's key cannot match. The key is
 * created-if-absent under the project lock the writer already holds.
 */
async function stampRunIntegrity(root: string, run: WorkflowRun): Promise<WorkflowRun> {
  const key = await loadOrCreateRunKey(root);
  return { ...run, integrity: runIntegrity(key, run) };
}

/**
 * Persist already-serialized run JSON to the confined `<runId>.json` leaf.
 *
 * Factored out so the normal {@link writeRun} and the terminal-escape
 * {@link writeTerminalRun} share the identical confinement (private dir + runs
 * subdir recheck + `atomicWrite` with `confineRoot`). `runId` is slug-safe-gated by
 * each caller, so it is the sole, safe interpolated path component.
 *
 * DURABLE: the run record is the SOURCE OF TRUTH for a run (and tracks the external
 * wiki writes its stage outputs land), so every run-record write goes through
 * `atomicWrite` with `durable: true` — fsync'd file + parent dir, surviving a power
 * loss. The hot wiki/compile path keeps the fast default elsewhere.
 */
async function persistRunJson(root: string, runId: string, json: string): Promise<void> {
  const privateDir = await resolveConfinedPrivateDir(root);
  const runsDir = await ensureRunsDir(privateDir);
  const leaf = path.join(runsDir, `${runId}.json`);
  await atomicWrite(leaf, json, { confineRoot: realRootOf(privateDir), durable: true });
}

/**
 * Return a minimized copy of a TERMINAL run that drops the large caller-controlled
 * `inputs`/`outputs` blobs (a terminal run's inputs/outputs are historical),
 * keeping status/runId/digests/stageLog/events. A `fields-truncated` marker is
 * appended via {@link appendTerminalEvent} so the loss is auditable, never silent.
 * The marker append also compacts the event trail if needed, so the result is
 * smaller on both axes. NOTE: this does NOT shrink a record dominated by a
 * NON-clearable field (`stageLog`/`knownStageIds`/`events`); {@link terminalTombstone}
 * is the guaranteed-minimal last resort for that case.
 */
function minimizeTerminalRun(run: WorkflowRun): WorkflowRun {
  const at = new Date().toISOString();
  const cleared: WorkflowRun = { ...run, inputs: {}, outputs: {} };
  return appendTerminalEvent(cleared, {
    type: "fields-truncated", at, actorKind: "system",
    detail: "inputs/outputs cleared to fit the run byte cap on termination",
  });
}

/** The marker detail recorded when a terminal run is reduced to a tombstone. */
const TOMBSTONE_DETAIL =
  "stageLog/knownStageIds/satisfiedGates/inputs/outputs and prior events dropped to fit the byte cap on termination";

/**
 * Return a GUARANTEED-minimal terminal TOMBSTONE for `run` — the last-resort that
 * cannot breach the byte cap. Keeps only the bounded identity/lifecycle fields
 * (`runId` ≤ 128 chars, the 64-hex digests, the short status/timestamps) and
 * EMPTIES every unbounded array (`stageLog`/`knownStageIds`/`satisfiedGates`) and
 * blob (`inputs`/`outputs`). The `events` trail is reduced to the genesis
 * `workflow-start` (kept if present, else a synthetic minimal one) plus ONE
 * `fields-truncated` marker noting the drop, so the audit degrades gracefully and
 * never silently. Every retained field has a bounded size, so the serialized
 * tombstone is a few hundred bytes << {@link MAX_WORKFLOW_RUN_BYTES} — the terminal
 * write provably fits. The run stays terminal, so it re-reads `ok` and classifies
 * `historical`.
 */
function terminalTombstone(run: WorkflowRun): WorkflowRun {
  const at = new Date().toISOString();
  const genesis = run.events.find((e) => e.type === "workflow-start")
    ?? { type: "workflow-start" as const, at: run.startedAt, actorKind: "system" as const, stateVersionBefore: 0, stateVersionAfter: 0 };
  const marker: WorkflowEvent = {
    type: "fields-truncated", at, actorKind: "system", detail: TOMBSTONE_DETAIL,
    stateVersionBefore: run.stateVersion, stateVersionAfter: run.stateVersion + 1,
  };
  return {
    schemaVersion: run.schemaVersion, runId: run.runId, workflowId: run.workflowId,
    workflowDigest: run.workflowDigest, profileDigest: run.profileDigest,
    status: run.status, currentStage: null, stateVersion: run.stateVersion + 1,
    startedAt: run.startedAt, updatedAt: at,
    stageLog: [], knownStageIds: [], satisfiedGates: [], inputs: {}, outputs: {},
    events: [genesis, marker],
  };
}

/**
 * Persist a TERMINAL run, ALWAYS succeeding within the byte cap. Tries the run as
 * given; if it would breach {@link MAX_WORKFLOW_RUN_BYTES}, retries with a
 * {@link minimizeTerminalRun} record (large `inputs`/`outputs` dropped + a
 * `fields-truncated` marker); if it STILL would breach (a record dominated by a
 * non-clearable field like a many-stage `stageLog`), falls back to a
 * {@link terminalTombstone} that is provably within the cap. A run is never an
 * un-retireable zombie at the byte cap. Returns the run as actually persisted.
 * Non-terminal writes keep failing closed over the cap via {@link writeRun} (correct
 * back-pressure).
 *
 * @param root - Absolute project root.
 * @param run - The terminal run to persist (its `runId` is the filename stem).
 * @returns The run as persisted (possibly minimized or tombstoned).
 * @throws {WorkflowRunIdError} If `run.runId` is not slug-safe.
 */
export async function writeTerminalRun(root: string, run: WorkflowRun): Promise<WorkflowRun> {
  if (!isValidRunId(run.runId)) {
    throw new WorkflowRunIdError(`not slug-safe or too long: ${JSON.stringify(run.runId.slice(0, 64))}`);
  }
  const key = await loadOrCreateRunKey(root);
  const stamp = (r: WorkflowRun): WorkflowRun => ({ ...r, integrity: runIntegrity(key, r) });
  const persisted = fitTerminalRun(run, stamp);
  await persistRunJson(root, persisted.run.runId, persisted.json);
  return persisted.run;
}

/** Stamp+serialize `run` if it fits the byte cap, else `null` (so the caller can degrade). */
function serializeIfFits(run: WorkflowRun, stamp: (r: WorkflowRun) => WorkflowRun): { run: WorkflowRun; json: string } | null {
  const stamped = stamp(run);
  try {
    return { run: stamped, json: serializeRunWithinCap(stamped) };
  } catch (err) {
    if (err instanceof WorkflowRunTooLargeError) return null;
    throw err;
  }
}

/**
 * Resolve a terminal run to the LARGEST representation that fits the byte cap, in
 * three tiers: the run as-is → {@link minimizeTerminalRun} → {@link terminalTombstone}
 * (provably within the cap, so the final serialize cannot throw). Each tier is
 * `stamp`ed with its integrity HMAC BEFORE the byte-cap check, so the persisted bytes
 * (which INCLUDE `integrity`) are what the cap is measured against — the tamper stamp
 * never tips an at-cap record over after the fact.
 */
function fitTerminalRun(run: WorkflowRun, stamp: (r: WorkflowRun) => WorkflowRun): { run: WorkflowRun; json: string } {
  const asIs = serializeIfFits(run, stamp);
  if (asIs !== null) return asIs;
  const minJson = serializeIfFits(minimizeTerminalRun(run), stamp);
  if (minJson !== null) return minJson;
  const tombstone = stamp(terminalTombstone(run));
  return { run: tombstone, json: serializeRunWithinCap(tombstone) };
}

/** A schema gate either yields the record to keep validating, or a rejection reason. */
type SchemaGate =
  | { kind: "ok"; record: Record<string, unknown> }
  | { kind: "reject"; detail: string };

/**
 * Gate `run.schemaVersion`, failing closed ONLY on a NEWER version and routing an
 * OLDER one through {@link migrateRun} (migrate-on-read; the migrated record is
 * persisted on the next `writeRun`). A non-numeric or future version →
 * `schema-too-new`. An older version that has no migration path → `unmigratable`.
 * The current version, or a successfully-migrated older one (re-stamped to CURRENT),
 * passes through for the remaining shape checks.
 */
function gateSchemaVersion(run: Record<string, unknown>): SchemaGate {
  const version = run.schemaVersion;
  if (typeof version !== "number" || version > WORKFLOW_RUN_SCHEMA_VERSION) {
    return { kind: "reject", detail: "schema-too-new" };
  }
  if (version === WORKFLOW_RUN_SCHEMA_VERSION) return { kind: "ok", record: run };
  const migrated = migrateRun(run, version);
  return migrated === null
    ? { kind: "reject", detail: "unmigratable" }
    : { kind: "ok", record: migrated };
}

/**
 * Validate an already-schema-gated record's id + deep shape + version chain,
 * returning `null` when it is trusted or the fail-closed `detail` otherwise. Factored
 * out of {@link runRejectionDetail} so each function stays simple: an in-JSON `runId`
 * that is slug-safe AND equals `expectedId` (`id-mismatch`), the deep shape check
 * ({@link hasValidRunShape} → `schema`), and the version chain
 * ({@link hasMonotonicVersionChain} → `version-chain`).
 */
function postSchemaRejection(run: Record<string, unknown>, expectedId: string): string | null {
  if (typeof run.runId !== "string" || !isValidRunId(run.runId) || run.runId !== expectedId) return "id-mismatch";
  if (!hasValidRunShape(run)) return "schema";
  if (!hasMonotonicVersionChain(run)) return "version-chain";
  return null;
}

/**
 * Run the fail-closed validation gates over a parsed top-level JSON value. Returns
 * the trusted (possibly migrated) record, or the `detail` reason it is untrusted.
 * Gates: object shape; the schema-version gate ({@link gateSchemaVersion} — newer
 * fails closed, older migrates); then the id + deep shape + version-chain gates
 * ({@link postSchemaRejection}).
 */
function runRejectionDetail(
  parsed: unknown,
  expectedId: string,
): { detail: string } | { record: Record<string, unknown> } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { detail: "schema" };
  const gate = gateSchemaVersion(parsed as Record<string, unknown>);
  if (gate.kind === "reject") return { detail: gate.detail };
  const detail = postSchemaRejection(gate.record, expectedId);
  return detail === null ? { record: gate.record } : { detail };
}

/**
 * Parse run bytes into a {@link WorkflowRunRead}, FAILING CLOSED (via
 * {@link runRejectionDetail}) on anything untrusted, THEN verifying the per-record
 * HMAC. The bytes are sync/attacker-controllable, so nothing fails open. A
 * successfully-migrated older record is returned `ok` (re-stamped to the current
 * version).
 *
 * The HMAC is recomputed over the AS-READ on-disk record (with `integrity` omitted),
 * NOT the migrated form — that is the object the writer signed. A MISSING or
 * MISMATCHED stamp → `unavailable:"integrity"`: a hand-edited / synced / restored /
 * foreign-key / keyless record is rejected even when its shape is impeccable.
 *
 * LEGACY UNSIGNED (v1): a record whose ON-DISK `schemaVersion` is below
 * {@link RUN_INTEGRITY_MIN_SCHEMA_VERSION} predates the HMAC, so it is structurally
 * unsigned. Its shape is migrated forward (so the ladder stays honest) but it is
 * surfaced as `unavailable:"legacy-unsigned"` — a DISTINCT reason from a tampered v2
 * `integrity` — never silently trusted, never silently bricked-without-reason.
 */
function parseRun(raw: string, expectedId: string, key: Buffer | null): WorkflowRunRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unavailable", detail: "corrupt" };
  }
  const verdict = runRejectionDetail(parsed, expectedId);
  if ("detail" in verdict) return { status: "unavailable", detail: verdict.detail };
  const onDiskVersion = (parsed as Record<string, unknown>).schemaVersion;
  if (typeof onDiskVersion === "number" && onDiskVersion < RUN_INTEGRITY_MIN_SCHEMA_VERSION) {
    return { status: "unavailable", detail: "legacy-unsigned" }; // pre-HMAC: never auto-trusted
  }
  const onDisk = parsed as WorkflowRun;
  if (key === null || !integrityMatches(onDisk.integrity, runIntegrity(key, onDisk))) {
    return { status: "unavailable", detail: "integrity" };
  }
  return { status: "ok", run: verdict.record as unknown as WorkflowRun };
}

/**
 * Read one run record by id. Returns `unavailable:"bad-id"` WITHOUT touching the
 * filesystem for a non-slug-safe id; `absent` when the private dir or leaf is
 * missing; `unavailable` (with a reason) for an escape, a symlinked/oversize leaf,
 * corrupt bytes, a too-new schema, an id mismatch, a failed shape check, a broken
 * version chain, or a missing/mismatched integrity HMAC; `ok` with the validated
 * record otherwise. The integrity key is loaded READ-ONLY (no creation on a pure
 * read); an absent key makes every record fail integrity (fail closed).
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id (also the filename stem).
 */
export async function readRun(root: string, runId: string): Promise<WorkflowRunRead> {
  if (!isValidRunId(runId)) return { status: "unavailable", detail: "bad-id" };
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { status: "unavailable", detail: "escape" };
  }
  if (privateDir === null) return { status: "absent" };
  const runsDir = await existingRunsDir(privateDir);
  if (runsDir.kind === "absent") return { status: "absent" };
  if (runsDir.kind === "escape") return { status: "unavailable", detail: "escape" };
  const read = await readCappedNoFollow(path.join(runsDir.dir, `${runId}.json`), MAX_WORKFLOW_RUN_BYTES);
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind === "unavailable") return { status: "unavailable", detail: "leaf" };
  return parseRun(read.body, runId, await loadRunKey(root));
}

/**
 * The structured outcome of {@link listRuns}: `ok` with the slug-safe run ids
 * (an EMPTY list is a genuinely-absent runs dir, NOT a fault), or `unavailable`
 * with a `detail` reason when the store cannot be enumerated (a private-dir/runs
 * -dir escape or a `readdir` failure). Distinguishing the two is load-bearing: a
 * broken store must NOT read as "no runs" (the unavailable-store-reads-as-healthy
 * class), so a caller can surface a problem instead of silently reporting clean.
 */
export type WorkflowRunList =
  | { status: "ok"; runIds: string[] }
  | { status: "unavailable"; detail: string };

/**
 * List the slug-safe run ids present under `.llmwiki/workflows/runs/`. Returns
 * `ok` with the (possibly empty) id list when the store is enumerable — an absent
 * private dir or absent runs dir is a clean `ok, []` (no runs yet). Returns
 * `unavailable` (with a reason) when the store cannot be read: a private-dir
 * resolver escape, an escaping intermediate `workflows` dir, or a `readdir`
 * failure. A filename that is not a `.json` file, or whose stem is not slug-safe,
 * is IGNORED (never returned).
 *
 * @param root - Absolute project root.
 * @returns A structured {@link WorkflowRunList}: `ok` with stems, or `unavailable`.
 */
export async function listRuns(root: string): Promise<WorkflowRunList> {
  let privateDir: string | null;
  try {
    privateDir = await resolveExistingConfinedPrivateDir(root);
  } catch {
    return { status: "unavailable", detail: "escape" };
  }
  if (privateDir === null) return { status: "ok", runIds: [] };
  const runsDir = await existingRunsDir(privateDir);
  if (runsDir.kind === "absent") return { status: "ok", runIds: [] };
  if (runsDir.kind === "escape") return { status: "unavailable", detail: "escape" };
  let entries: string[];
  try {
    entries = await readdir(runsDir.dir);
  } catch {
    return { status: "unavailable", detail: "readdir-failed" };
  }
  const runIds = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((stem) => isSlugSafe(stem));
  return { status: "ok", runIds };
}

/** How {@link resolveRunId} reports a run id it could not resolve. */
export type RunIdResolution =
  | { status: "resolved"; runId: string }
  | { status: "not-found" }
  | { status: "unavailable"; detail: string };

/**
 * Resolve a raw run id against the store. Never touches the filesystem with an
 * unvalidated id (the {@link isValidRunId} gate short-circuits before
 * {@link listRuns}). An `unavailable` store is SURFACED (not silently treated as
 * "not found"), so a broken store does not look like a clean miss.
 *
 * @param root - Absolute project root.
 * @param rawId - The candidate run id.
 * @returns `resolved` when slug-safe and present; `not-found` when absent or
 *   invalid; `unavailable` (with detail) when the store could not be enumerated.
 */
export async function resolveRunId(root: string, rawId: string): Promise<RunIdResolution> {
  if (!isValidRunId(rawId)) return { status: "not-found" };
  const list = await listRuns(root);
  if (list.status === "unavailable") return { status: "unavailable", detail: list.detail };
  return list.runIds.includes(rawId) ? { status: "resolved", runId: rawId } : { status: "not-found" };
}
