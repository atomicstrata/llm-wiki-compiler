/**
 * @file src/indexed/run-retire.ts
 * @description EXPLICIT RETIREMENT of finished batch compile run stores
 * (`.llmwiki/indexed/crun-<id>`) of a `local-indexed` project: a read-only
 * PREVIEW that classifies every run and returns a plan, and an APPLY that
 * retires exactly what a still-current plan names.
 *
 * WHAT GOES AND WHAT STAYS: `./run-retire-inventory.ts` (finished runs that are
 * not the compile state's last run, and superseded runs with no restart
 * publication evidence; every pinned, active, evidence-carrying or newest
 * `keepFinished` run stays). A retired run's REPORT is intentionally lost:
 * `compile --report <id>` then refuses as an unknown run, so page it first or
 * raise `keepFinished`. Retirement is judged against the CURRENT compile state
 * and makes no promise about any later one; an indexed backup never holds run
 * stores, so no restore brings retired run history back.
 *
 * APPLY, in this order, with nothing deleted before step 5:
 * 1. strict plan parse; the operator must assert `readersOffline` (processes of
 *    builds without reader leases, and other tools, are invisible);
 * 2. the maintenance acquisition (`./maintenance-lock.ts`): no prior read of the
 *    stores in this process, the RAW project lock (so no batch compile, GC,
 *    restore, pin or other retirement runs), the read-only custody legs, and,
 *    in the same locked lease-free scope, the WHOLE inventory recomputed: no
 *    blocker, and exactly the plan's bindings;
 * 3. as the collector: a stale barrier is removed, this retirement's BARRIER is
 *    published (`../segments/retire-barrier.ts`), THEN the reader census runs
 *    (a live or uncertain lease removes the barrier and refuses);
 * 4. the plan's owned interrupted cleanups are finished;
 * 5. each candidate is retired (`./run-retire-quarantine.ts`: receipt, rename
 *    commit, identity-bound cleanup);
 * 6. the empty quarantine and the barrier are removed.
 * ACCOUNTING. A run counts as RETIRED from its rename commit (whether or not
 * its cleanup finished, `cleanupComplete`); `reclaimedBytes` counts only leaves
 * actually unlinked. Any failure after the census is `indexed_runs_partial`,
 * carrying that account; every state left is consistent and a new preview plans
 * the rest. A barrier that cannot be removed after a completed retirement is
 * `indexed_runs_cleanup_failed`, carrying the full account (the retirement DID
 * happen); the barrier stops blocking reads once this process ends.
 *
 * The locked inventory hands back only plain metadata it validated; that no
 * snapshot or iterator leaves the locked scope is this module's discipline
 * (the callback returns nothing), not something the type system proves.
 */

import { createHash } from "node:crypto";
import { isRunStoreName } from "../compiler/batch/contracts.js";
import { canonicalRoot, readerCensus, type ReaderCensusV1 } from "../segments/reader-lease.js";
import { clearStaleRetireBarrier, publishRetireBarrier, removeRetireBarrier } from "../segments/retire-barrier.js";
import { MAX_STORES } from "./gc-inventory.js";
import { withMaintenanceLock } from "./maintenance-lock.js";
import { inventoryRuns, type RunEntryV1, type RunInventoryV1 } from "./run-retire-inventory.js";
import { finishCleanup, MAX_RETIRE_LEAVES, removeQuarantineIfEmpty, retireStore, type PendingPhaseV1, type RetireStepForTest } from "./run-retire-quarantine.js";

const PLAN_FORMAT = "llmwiki-batch-run-retirement-plan";
/** The newest finished runs a retirement keeps for their reports unless told otherwise. */
const DEFAULT_KEEP_FINISHED = 10;
const MAX_KEEP_FINISHED = 1_000;
/** An ISO timestamp, generously bounded. */
const MAX_TIMESTAMP_CHARS = 64;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Why a retirement stopped. Every code except `indexed_runs_partial` and
 * `indexed_runs_cleanup_failed` is a PREFLIGHT refusal: nothing was retired.
 * `indexed_runs_cleanup_failed` follows a COMPLETED retirement.
 */
export type IndexedRunsErrorCode =
  | "indexed_runs_offline_unconfirmed" | "indexed_runs_readers_active" | "indexed_runs_blocked" | "indexed_runs_plan_stale" | "indexed_runs_plan_invalid"
  | "indexed_runs_partial" | "indexed_runs_cleanup_failed";

/** One run retired by this apply: committed at its rename, its cleanup finished or not. */
export interface RunRetiredV1 {
  readonly runId: string;
  readonly store: string;
  readonly leaves: number;
  readonly bytes: number;
  /** Whether its quarantined leaves, directory and receipt are gone (otherwise the next apply finishes them). */
  readonly cleanupComplete: boolean;
}

/** What a retirement retired and finished. */
export interface RunRetireDoneV1 {
  readonly retired: readonly RunRetiredV1[];
  /** Interrupted cleanups (from an earlier apply) finished first. */
  readonly cleaned: number;
  /** Bytes of the leaves this apply actually unlinked. */
  readonly reclaimedBytes: number;
  /** PARTIAL ONLY: the store whose step failed; it may already be retired (its cleanup then finishes on the next apply). */
  readonly interrupted?: string;
}

/** A typed retirement refusal; `partial` (the account so far) is present exactly on `indexed_runs_partial` and `indexed_runs_cleanup_failed`. */
export class IndexedRunsError extends Error {
  constructor(readonly code: IndexedRunsErrorCode, message: string, readonly partial?: RunRetireDoneV1) {
    super(`${code}: ${message}`);
    this.name = "IndexedRunsError";
  }
}

/** One candidate's binding in a plan. */
export interface RunRetirePlanCandidateV1 { readonly store: string; readonly manifestSha256: string; readonly leafDigest: string; readonly leaves: number; readonly bytes: number }
/** One owned interrupted cleanup's binding in a plan. */
export interface RunRetirePlanCleanupV1 { readonly store: string; readonly receiptSha256: string; readonly phase: PendingPhaseV1 }

/** A retirement plan: pass it back unchanged to apply. */
export interface RunRetirePlanV1 {
  readonly format: typeof PLAN_FORMAT;
  readonly version: 1;
  readonly createdAt: string;
  readonly rootDigest: string;
  readonly keepFinished: number;
  readonly cstateManifestSha256: string | null;
  readonly lastRun: string | null;
  readonly pinsDigest: string;
  readonly runSetDigest: string;
  readonly candidates: readonly RunRetirePlanCandidateV1[];
  readonly pendingCleanup: readonly RunRetirePlanCleanupV1[];
}

/** What a preview found. */
export interface RunRetirePreviewV1 {
  readonly plan: RunRetirePlanV1;
  /** Whether apply could accept this plan now (no blocker). */
  readonly admissible: boolean;
  readonly blockers: readonly string[];
  /** Every run with its class and why. */
  readonly runs: readonly RunEntryV1[];
  readonly retirableRuns: number;
  readonly retirableBytes: number;
  readonly pendingCleanup: number;
  /** The runs whose reports an apply of this plan deletes. */
  readonly reportsLost: readonly string[];
  /** Whether eligible runs were deferred by the plan's leaf budget (retire again afterwards). */
  readonly truncated: boolean;
}

/** What an apply did. */
export interface RunRetireApplyV1 extends RunRetireDoneV1 {
  /** Leases of exited processes the census ignored. */
  readonly staleLeases: number;
}

/** Options of an apply. */
export interface RunRetireApplyOptions {
  /** The operator's assertion that no reader without a lease (an older build, another tool) is running. */
  readonly readersOffline?: boolean;
  /** Test-only seam after the census, with the barrier published. */
  readonly afterCensusForTest?: () => Promise<void>;
  /** Test-only fault seam at each store step. */
  readonly stepForTest?: RetireStepForTest;
}

/** An error's message. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `keepFinished` to use, refusing anything but an integer in range. */
function checkedKeep(keepFinished: number | undefined): number {
  const keep = keepFinished ?? DEFAULT_KEEP_FINISHED;
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > MAX_KEEP_FINISHED) throw new IndexedRunsError("indexed_runs_plan_invalid", `keepFinished must be an integer from 0 to ${MAX_KEEP_FINISHED}`);
  return keep;
}

/** The plan that binds `inventory`. */
function planOf(inventory: RunInventoryV1, keepFinished: number): RunRetirePlanV1 {
  const { rootDigest, cstateManifestSha256, lastRun, pinsDigest, runSetDigest } = inventory;
  return {
    format: PLAN_FORMAT, version: 1, createdAt: new Date().toISOString(), rootDigest, keepFinished, cstateManifestSha256, lastRun, pinsDigest, runSetDigest,
    candidates: inventory.candidates.map(({ store, manifestSha256, leafDigest, leaves, bytes }) => ({ store, manifestSha256, leafDigest, leaves, bytes })),
    pendingCleanup: inventory.pendingCleanup.map(({ store, receiptSha256, phase }) => ({ store, receiptSha256, phase })),
  };
}

/** Everything a plan binds, in a fixed order (its creation time aside). */
function bindingOf(plan: RunRetirePlanV1): string {
  const { rootDigest, keepFinished, cstateManifestSha256, lastRun, pinsDigest, runSetDigest } = plan;
  return JSON.stringify([rootDigest, keepFinished, cstateManifestSha256, lastRun, pinsDigest, runSetDigest,
    plan.candidates.map((c) => [c.store, c.manifestSha256, c.leafDigest, c.leaves, c.bytes]), plan.pendingCleanup.map((p) => [p.store, p.receiptSha256, p.phase])]);
}

/** Preview a retirement: read-only (it reads superseded runs' evidence under this process's reader lease). */
export async function previewRunRetirement(root: string, options: { readonly keepFinished?: number } = {}): Promise<RunRetirePreviewV1> {
  const keepFinished = checkedKeep(options.keepFinished);
  const inventory = await inventoryRuns(await canonicalRoot(root), keepFinished);
  return {
    plan: planOf(inventory, keepFinished), admissible: inventory.blockers.length === 0, blockers: inventory.blockers, runs: inventory.runs,
    retirableRuns: inventory.candidates.length, retirableBytes: inventory.candidates.reduce((sum, c) => sum + c.bytes, 0),
    pendingCleanup: inventory.pendingCleanup.length, reportsLost: inventory.candidates.map((c) => c.runId), truncated: inventory.truncated,
  };
}

/** Whether `value` is an object with exactly `keys` (sorted, comma-joined). */
function hasExactKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
}

/** A whole number in `[0, max]`. */
const isCount = (value: unknown, max: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
/** A lowercase hex SHA-256. */
const isHex64 = (value: unknown): boolean => typeof value === "string" && HEX64.test(value);
/** A digest, or empty (a blocked inventory binds none). */
const isOptionalDigest = (value: unknown): boolean => value === "" || isHex64(value);

/** Whether `value` is one strict plan candidate. */
function isPlanCandidate(value: unknown): boolean {
  if (!hasExactKeys(value, "bytes,leafDigest,leaves,manifestSha256,store")) return false;
  return typeof value.store === "string" && isRunStoreName(value.store) && isHex64(value.manifestSha256) && isHex64(value.leafDigest) && isCount(value.leaves, MAX_RETIRE_LEAVES) && isCount(value.bytes, Number.MAX_SAFE_INTEGER);
}

/** Whether `value` is one strict plan cleanup. */
function isPlanCleanup(value: unknown): boolean {
  if (!hasExactKeys(value, "phase,receiptSha256,store")) return false;
  return typeof value.store === "string" && isRunStoreName(value.store) && isHex64(value.receiptSha256) && ["unmoved", "moved", "removed"].includes(value.phase as string);
}

/** Whether a plan header names this format and version, a bounded creation time and a root digest. */
function planIdentityValid(value: Record<string, unknown>): boolean {
  return value.format === PLAN_FORMAT && value.version === 1 && typeof value.createdAt === "string" && value.createdAt.length <= MAX_TIMESTAMP_CHARS && isHex64(value.rootDigest);
}

/** Whether a plan header's retention, compile-state, last-run, pin and run-set bindings are well formed. */
function planBindingsValid(value: Record<string, unknown>): boolean {
  const state = isCount(value.keepFinished, MAX_KEEP_FINISHED) && (value.cstateManifestSha256 === null || isHex64(value.cstateManifestSha256));
  const lastRun = value.lastRun === null || (typeof value.lastRun === "string" && /^[0-9a-f]{12}$/.test(value.lastRun));
  return state && lastRun && isOptionalDigest(value.pinsDigest) && isOptionalDigest(value.runSetDigest);
}

/** Whether a plan header's two lists are arrays within the store cap. */
function planListsValid(value: Record<string, unknown>): boolean {
  return Array.isArray(value.candidates) && value.candidates.length <= MAX_STORES && Array.isArray(value.pendingCleanup) && value.pendingCleanup.length <= MAX_STORES;
}

/** Whether `value` has a version 1 plan's header. */
function isPlanHeader(value: unknown): value is Record<string, unknown> & { candidates: unknown[]; pendingCleanup: unknown[] } {
  if (!hasExactKeys(value, "candidates,createdAt,cstateManifestSha256,format,keepFinished,lastRun,pendingCleanup,pinsDigest,rootDigest,runSetDigest,version")) return false;
  return planIdentityValid(value) && planBindingsValid(value) && planListsValid(value);
}

/** Parse a plan strictly. */
function parseRetirePlan(value: unknown): RunRetirePlanV1 {
  if (!isPlanHeader(value)) throw new IndexedRunsError("indexed_runs_plan_invalid", "the plan is not a version 1 batch run retirement plan");
  if (!value.candidates.every(isPlanCandidate) || !value.pendingCleanup.every(isPlanCleanup)) throw new IndexedRunsError("indexed_runs_plan_invalid", "a plan entry is malformed");
  const plan = value as unknown as RunRetirePlanV1;
  const stores = plan.candidates.map((c) => c.store);
  if (new Set(stores).size !== stores.length || new Set(plan.pendingCleanup.map((p) => p.store)).size !== plan.pendingCleanup.length) throw new IndexedRunsError("indexed_runs_plan_invalid", "the plan names a store twice");
  return plan;
}

/** Refuse unless `inventory` is exactly what `plan` bound. */
function assertCurrent(plan: RunRetirePlanV1, inventory: RunInventoryV1): void {
  if (inventory.blockers.length > 0) throw new IndexedRunsError("indexed_runs_blocked", inventory.blockers.slice(0, 5).join("; "));
  if (bindingOf(planOf(inventory, plan.keepFinished)) !== bindingOf(plan)) {
    throw new IndexedRunsError("indexed_runs_plan_stale", "the project changed since the plan was made (a run, the compile state, a pin, a run store's leaves or a cleanup); preview again");
  }
}

/** Refuse unless the census found only stale leases. */
function assertNoReaders(census: ReaderCensusV1): void {
  const busy = [...census.live, ...census.uncertain];
  if (busy.length > 0) throw new IndexedRunsError("indexed_runs_readers_active", `reader leases are live or cannot be classified: ${busy.slice(0, 5).join(", ")}; stop those processes (MCP servers, viewers, watchers, report readers) and preview again`);
}

/**
 * Run `body` holding this retirement's barrier. A stale one (an interrupted
 * publication included) is re-proved and cleared first, under the raw lock and
 * after `assertCurrent`, so every reserved name is absent before a new token.
 * After a failure the removal is best effort: the failure is what the caller
 * must see, and a barrier left behind blocks reads only while this process lives.
 */
async function withBarrier<T extends RunRetireDoneV1>(root: string, planDigest: string, staleBarrier: boolean, body: (token: string) => Promise<T>): Promise<T> {
  if (staleBarrier) await clearStaleRetireBarrier(root);
  const token = await publishRetireBarrier(root, planDigest);
  let result: T;
  try {
    result = await body(token);
  } catch (error) {
    await removeRetireBarrier(root, { token }).catch(() => undefined);
    throw error;
  }
  try { await removeRetireBarrier(root, { token }); } catch (error) {
    throw new IndexedRunsError("indexed_runs_cleanup_failed", `the retirement completed but its barrier could not be removed (${messageOf(error)}); other processes' reads refuse until this process exits`, result);
  }
  return result;
}

/** Finish the owned cleanups, then retire every candidate; any failure is `indexed_runs_partial` with the account so far. */
async function retireAll(root: string, inventory: RunInventoryV1, token: string, step?: RetireStepForTest): Promise<RunRetireDoneV1> {
  const retired: { -readonly [key in keyof RunRetiredV1]: RunRetiredV1[key] }[] = [];
  const account = { cleaned: 0, reclaimedBytes: 0, current: undefined as string | undefined };
  const reclaimed = (bytes: number): void => { account.reclaimedBytes += bytes; };
  try {
    for (const pending of inventory.pendingCleanup) { account.current = pending.store; await finishCleanup(root, pending, { committed: () => undefined, reclaimed }); account.cleaned += 1; }
    for (const candidate of inventory.candidates) {
      account.current = candidate.store;
      // Counted as retired at its rename commit, before any cleanup.
      const committed = () => { retired.push({ runId: candidate.runId, store: candidate.store, leaves: candidate.leaves, bytes: candidate.bytes, cleanupComplete: false }); };
      await retireStore(root, candidate, token, { committed, reclaimed }, step);
      retired[retired.length - 1]!.cleanupComplete = true;
    }
    account.current = undefined;
    await removeQuarantineIfEmpty(root);
  } catch (error) {
    const done = { retired, cleaned: account.cleaned, reclaimedBytes: account.reclaimedBytes, ...(account.current === undefined ? {} : { interrupted: account.current }) };
    throw new IndexedRunsError("indexed_runs_partial", `${messageOf(error)}${account.current === undefined ? "" : ` while handling ${account.current}`}; ${retired.length} run(s) retired (${retired.filter((run) => !run.cleanupComplete).length} with cleanup unfinished) and ${account.cleaned} interrupted cleanup(s) finished before it stopped; every state left is consistent, preview again`, done);
  }
  return { retired, cleaned: account.cleaned, reclaimedBytes: account.reclaimedBytes };
}

/** The locked half of an apply over canonical `root`, as the collector. */
async function retireLocked(root: string, plan: RunRetirePlanV1, inventory: RunInventoryV1, options: RunRetireApplyOptions): Promise<RunRetireApplyV1> {
  assertCurrent(plan, inventory);
  const planDigest = createHash("sha256").update(bindingOf(plan)).digest("hex");
  return withBarrier(root, planDigest, inventory.staleBarrier, async (token) => {
    const census = await readerCensus(root);
    assertNoReaders(census);
    await options.afterCensusForTest?.();
    return { ...(await retireAll(root, inventory, token, options.stepForTest)), staleLeases: census.stale.length };
  });
}

/** Apply a still-current plan from {@link previewRunRetirement}. See the file comment for every refusal. */
export async function applyRunRetirement(root: string, planValue: unknown, options: RunRetireApplyOptions = {}): Promise<RunRetireApplyV1> {
  const plan = parseRetirePlan(planValue);
  if (options.readersOffline !== true) {
    throw new IndexedRunsError("indexed_runs_offline_unconfirmed", "assert readersOffline: no llmwiki process from a build without reader leases, and no other tool, may be reading .llmwiki/indexed; leases cannot reveal them");
  }
  const canonical = await canonicalRoot(root);
  // Filled inside the locked lease-free scope; only plain, validated metadata leaves it.
  const locked: { inventory?: RunInventoryV1 } = {};
  const lockedCheck = async (): Promise<void> => { locked.inventory = await inventoryRuns(canonical, plan.keepFinished); };
  return withMaintenanceLock(canonical, { lockedCheck }, () => retireLocked(canonical, plan, locked.inventory!, options));
}
