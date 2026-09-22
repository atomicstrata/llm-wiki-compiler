/**
 * @file src/local-workflow-host/run-store.ts
 * @description Compiler-owned confined, signed local-run persistence. Callers hold the project mutation lock; the constructed host additionally checks its transaction lease.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/markdown.js";
import { safeRealpath, isInsideDir } from "../utils/path-confine.js";
import { resolveConfinedPrivateDir } from "../utils/private-dir.js";
import { isValidRunId, runsDirFor } from "../workflow-history/paths.js";
import { runIntegrity } from "../workflow-history/integrity.js";
import { loadOrCreateRunKey } from "./run-key.js";
import { WorkflowRunIdError, WorkflowRunTooLargeError, serializeRunWithinCap } from "./run-codec.js";
import type { WorkflowRun } from "../workflow-history/types.js";



/**
 * The realpath'd project root that `atomicWrite`'s `confineRoot` must use. The
 * resolvers return the REALPATH'd `.llmwiki`, so its parent IS the realpath'd root.
 */
function realRootOf(privateDir: string): string {
  return path.dirname(privateDir);
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

/** Persist the first fitting engine-supplied representation, signing each with one project key.
 * Candidates are lazy so fallback timestamps and truncation events are created only
 * when needed. Core owns size enforcement and custody, not terminal compaction policy.
 */
export async function writeRunCandidates(root: string, candidates: Iterable<WorkflowRun>): Promise<WorkflowRun> {
  let key: Awaited<ReturnType<typeof loadOrCreateRunKey>> | undefined;
  let runId: string | undefined;
  let oversized: WorkflowRunTooLargeError | undefined;
  for (const candidate of candidates) {
    if (!isValidRunId(candidate.runId) || (runId !== undefined && candidate.runId !== runId)) {
      throw new WorkflowRunIdError("candidate run id is invalid or changed");
    }
    runId = candidate.runId;
    key ??= await loadOrCreateRunKey(root);
    const stamped = { ...candidate, integrity: runIntegrity(key, candidate) };
    let json: string;
    try {
      json = serializeRunWithinCap(stamped);
    } catch (error) {
      if (!(error instanceof WorkflowRunTooLargeError)) throw error;
      oversized = error;
      continue;
    }
    await persistRunJson(root, runId, json);
    return stamped;
  }
  if (oversized !== undefined) throw oversized;
  throw new WorkflowRunIdError("no run candidates supplied");
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
