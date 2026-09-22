/**
 * @file src/workflow-history/store.ts
 * @description Authenticated, confined, passive run-history reads. Never creates directories or keys.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { MAX_WORKFLOW_RUN_BYTES } from "../utils/constants.js";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { isSlugSafe } from "../profile/identity.js";
import { resolveExistingConfinedPrivateDir } from "../utils/private-dir.js";
import { migrateRun } from "./run-migrate.js";
import { hasValidRunShape, hasMonotonicVersionChain } from "./run-validate.js";
import { loadRunKey, runIntegrity, integrityMatches } from "./integrity.js";
import { isValidRunId, runsDirFor } from "./paths.js";
import { WORKFLOW_RUN_SCHEMA_VERSION, RUN_INTEGRITY_MIN_SCHEMA_VERSION, type WorkflowRun } from "./types.js";
/** The trust-aware result of reading a single run record. */
export type WorkflowRunRead =
  | { status: "ok"; run: WorkflowRun }
  | { status: "absent" }
  | { status: "unavailable"; detail: string };


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
