/**
 * @file src/scale/downgrade-apply.ts
 * @description APPLYING a scale-down plan, and resuming one.
 *
 * FROM `local-large` (record only): under the gated project lock (intent
 * `scale`) the inventory is recomputed and must equal the plan; then the
 * version 1 record of `local-standard` replaces the current one. No data
 * moves: the only behaviour `local-large` adds is the binary embedding
 * selection, and `local-standard` keeps an existing binary store.
 *
 * FROM `local-indexed`, in this order (A1-A10):
 * 1. strict plan (the caller parsed it) and the operator's assertion that no
 *    reader of a build without leases runs;
 * 2. the maintenance acquisition (`../indexed/maintenance-lock.ts`); in its
 *    locked, lease-free scope a fresh apply recomputes the WHOLE plan, which
 *    must equal this one, and fully verifies every indexed store;
 * 3. the bootstrap intent (create-only, before any record change);
 * 4. a stale barrier removed, OUR barrier published, the reader census;
 * 5. the FENCE record (compare-and-swap; outcome classified by an exact read);
 * 6. the fenced phases inside the private access scope (`./downgrade-fenced.ts`):
 *    stage, install, verify, archive, receipt, activation (last);
 * 7. our barrier removed and the intent retired into the evidence directory.
 * Resume classifies the project by the intent, the record and the receipt:
 * bootstrapped (intent, original record; or a newer record while the intent
 * provably never fenced, `./downgrade-commit.ts`) re-checks and fences, or
 * retires the intent if the plan went stale; fenced continues the phases; COMMITTED
 * (receipt, the indexed stores archived, a readable record past the fence)
 * only cleans up, whatever later revisions or ordinary writes did since.
 * With no live intent, the same COMMITTED proof over this plan's exact
 * retired intent (`./downgrade-commit.ts`, RETIREMENT REPLAY) finishes a
 * retirement whose rename outlived a failed parent checkpoint: under the raw
 * lock both parents are synced again before any barrier cleanup, the live
 * intent is never recreated and the current record is never touched.
 * Without that proof the state is fresh, exactly as before.
 * A plan whose evidence directory holds a cancel intent or receipt
 * (`./downgrade-cancel.ts`) is refused: cheaply at entry, and AGAIN inside the
 * held lock before any bootstrap, fence or install (a cancel may complete
 * between the entry check and the lock acquisition).
 */

import { INDEXED_DIR } from "../segments/contracts.js";
import { isDeepStrictEqual } from "node:util";
import { createDowngradeIntent, readDowngradeIntent, runWithDowngradeAccess, type DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { withMaintenanceLock } from "../indexed/maintenance-lock.js";
import { verifyIndexedStores } from "../indexed/verify.js";
import { canonicalRoot } from "../segments/reader-lease.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { SCALE_RECORD_FILE, type ScaleRequest } from "./contracts.js";
import type { ScaleRecord, ScaleRecordV2 } from "./contracts-v2.js";
import { DOWNGRADE_INTENT_FILE, ScaleDowngradeError, type DowngradeNoticeCode, type DowngradeRunV1, type DowngradeSeamFn } from "./downgrade-contracts.js";
import { runFencedPhases } from "./downgrade-fenced.js";
import { identityAt, leafDigest, renameBound } from "./downgrade-fs.js";
import { inventoryDowngrade, spaceBlocker } from "./downgrade-inventory.js";
import { downgradeDir, readReceipt, recordPlan } from "./downgrade-journal.js";
import { assertPlanCurrent, assertUnblocked, buildDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";
import { activationRecord, fenceRecord, syncPublishedDowngradeRecord, writeClassified } from "./downgrade-records.js";
import { holdBarrier, releaseBarrier, removeStaleBarrierOf } from "./downgrade-barrier.js";
import { committedAt, finishRetirement, isRetiredIntent, retireOwnIntent, staleBeforeFence } from "./downgrade-commit.js";
import { isOwnFence } from "./downgrade-cancel-bind.js";
import { repairBootstrapIntent } from "./downgrade-bootstrap-evidence.js";
import { assertNotCancelled } from "./downgrade-cancel-evidence.js";
import { diskScaleRecordIo, readScaleRecord } from "./record.js";
import { diskPreflightIo, type PreflightIo } from "./steps.js";

/** How an apply runs. */
export interface DowngradeApplyOptions {
  /** The operator's assertion that no build without reader leases, and no other tool, reads the project. Required. */
  readonly readersOffline: boolean;
  /** TEST SEAM: the free-space measurement. Absent: the project's file system. */
  readonly space?: PreflightIo;
  /** TEST SEAM: announced after each durable checkpoint. */
  readonly seam?: DowngradeSeamFn;
}

/** What an applied (or completed) scale-down did. */
export interface DowngradeApplyResultV1 {
  readonly target: string;
  /** The activation record's revision (this scale-down's own, even when later revisions followed it). */
  readonly revision: number;
  /** Only when a committed scale-down's cleanup ran after later record changes: the record now (which the cleanup did not touch). */
  readonly current?: { readonly revision: number; readonly architecture: string };
  /** The retained evidence directory (indexed only). */
  readonly dir: string | null;
  readonly installed: readonly string[];
  readonly retainedPriors: readonly string[];
  readonly archivedStores: number;
  readonly runs: readonly DowngradeRunV1[];
  readonly lastRun: string | null;
  readonly notices: readonly DowngradeNoticeCode[];
  /** True when this apply finished an earlier interrupted one. */
  readonly resumed: boolean;
}

/** Where an indexed scale-down stands. */
type Phase = { kind: "fresh" } | { kind: "bootstrapped"; intent: DowngradeIntentV1 } | { kind: "fenced"; intent: DowngradeIntentV1; fence: ScaleRecordV2 }
  | { kind: "committed"; intent: DowngradeIntentV1; record: ScaleRecord; retired: boolean };

/** Refuse with a partial fault. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** The request whose plan is `plan`'s estimate (the stated figures only). */
function requestOf(plan: DowngradePlanV1): ScaleRequest {
  const { requested } = plan.inventory;
  return { ...(requested.sizeBasis === "stated" ? { sizeBytes: requested.sizeBytes } : {}), ...(requested.documentsBasis === "stated" ? { documents: requested.documents } : {}) };
}

/** The plan recomputed now for `root`. */
async function currentPlan(root: string, plan: DowngradePlanV1): Promise<DowngradePlanV1> {
  return buildDowngradePlan(root, await inventoryDowngrade(root, { target: plan.inventory.target, request: requestOf(plan) }));
}

/** Classify the project for `plan` by its intent, record and receipt. */
async function classify(root: string, plan: DowngradePlanV1): Promise<Phase> {
  const intent = await readDowngradeIntent(root);
  const read = await readScaleRecord(root);
  const record = read.kind === "ok" ? read.record : null;
  if (intent.kind === "unreadable") fault(`${DOWNGRADE_INTENT_FILE} cannot be read`);
  if (intent.kind === "absent") return absentPhase(root, plan, record);
  if (intent.intent.plan !== plan.digest) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", `another scale-down (plan ${intent.intent.plan}) is in progress; re-run that plan`);
  if (!isDeepStrictEqual(intent.intent, intentOf(plan))) fault("the live intent is not the exact intent derived from this plan");
  return phaseOf(root, plan, intent.intent, record);
}

/** No live intent: a fence without one refuses; this plan's exact retired intent with a proved commit is committed; otherwise fresh. */
async function absentPhase(root: string, plan: DowngradePlanV1, record: ScaleRecord | null): Promise<Phase> {
  if (record?.pending?.kind === "downgrade") return fault(`a scale-down fence exists without ${DOWNGRADE_INTENT_FILE}`);
  const intent = intentOf(plan);
  if ((await isRetiredIntent(root, intent)) && (await committedAt(root, plan, intent, record))) return { kind: "committed", intent, record: record!, retired: true };
  return { kind: "fresh" };
}

/** The phase of a scale-down whose intent is `intent`, by the record on disk. */
async function phaseOf(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1, record: ScaleRecord | null): Promise<Phase> {
  const digest = await leafDigest(root, SCALE_RECORD_FILE);
  if (digest.kind === "ok" && digest.sha256 === intent.originalRecordSha256) return { kind: "bootstrapped", intent };
  if (record !== null && isOwnFence(record, plan, intent)) return { kind: "fenced", intent, fence: record as ScaleRecordV2 };
  if (await committedAt(root, plan, intent, record)) return { kind: "committed", intent, record: record!, retired: false };
  // An intent that provably never fenced is still bootstrapped: the locked re-check finds the plan stale and retires it.
  if (await staleBeforeFence(root, plan, intent, record)) return { kind: "bootstrapped", intent };
  return fault("the scale record is neither the original, this scale-down's fence, nor a committed successor");
}

/** The intent of `plan`, fenced one revision past its original record (the cancel derives the same intent). */
export function intentOf(plan: DowngradePlanV1): DowngradeIntentV1 {
  const fenceRevision = plan.inventory.record.revision + 1;
  return {
    format: "llmwiki-scale-downgrade-intent", version: 1, plan: plan.digest, target: plan.inventory.target,
    originalRevision: plan.inventory.record.revision, originalRecordSha256: plan.inventory.record.sha256, fenceRevision, dir: downgradeDir(plan, fenceRevision),
  };
}

/** The result of a scale-down that reached its activation. */
function resultOf(plan: DowngradePlanV1, revision: number, dir: string | null, resumed: boolean): DowngradeApplyResultV1 {
  const { inventory } = plan;
  return {
    target: inventory.target, revision, dir, resumed, installed: inventory.units.filter((unit) => unit.present).map((unit) => unit.relPath),
    retainedPriors: inventory.priors.filter((prior) => prior.sha256 !== null).map((prior) => prior.relPath), archivedStores: inventory.stores.length,
    runs: inventory.runs, lastRun: inventory.lastRun, notices: inventory.notices,
  };
}

/** The checks of a fresh or bootstrapped apply, in the locked lease-free scope: the plan is current, the stores verify, space suffices. */
async function lockedChecks(root: string, plan: DowngradePlanV1, space: PreflightIo, outcome: { current?: boolean }): Promise<void> {
  outcome.current = (await currentPlan(root, plan)).digest === plan.digest;
  if (!outcome.current) return;
  const report = await verifyIndexedStores(root);
  if (!report.ok) throw new ScaleDowngradeError("scale_downgrade_blocked", `the indexed stores do not verify: ${report.stores[0]?.store}: ${report.stores[0]?.problems.join("; ")}`);
  const blocker = await spaceBlocker(plan.inventory, space);
  if (blocker !== null) throw new ScaleDowngradeError("scale_downgrade_blocked", `${blocker.code}: ${blocker.detail}`, { blockers: [blocker] });
}

/** Bootstrap (when fresh), take the barrier and census (its token kept in `held`), write the fence; returns the fence record. */
async function fence(root: string, plan: DowngradePlanV1, phase: Phase, options: DowngradeApplyOptions, held: { token?: string }): Promise<{ fence: ScaleRecordV2; intent: DowngradeIntentV1 }> {
  const intent = phase.kind === "fresh" ? intentOf(plan) : (phase as { intent: DowngradeIntentV1 }).intent;
  await recordPlan(root, intent.dir, plan, phase.kind !== "fresh");
  await createDowngradeIntent(root, intent, phase.kind !== "fresh");
  if (phase.kind === "fresh") await options.seam?.("after-intent");
  held.token = await holdBarrier(root, plan.digest);
  if (phase.kind === "fenced") {
    await syncPublishedDowngradeRecord(root, phase.fence);
    return { fence: phase.fence, intent };
  }
  const read = await readScaleRecord(root);
  if (read.kind !== "ok" || read.record.version === 1) fault("the original record changed while the scale-down started");
  const next = fenceRecord(read.record as ScaleRecordV2, plan.inventory.requested, plan.inventory.target, plan.digest);
  await writeClassified(root, diskScaleRecordIo(root), next, read.record);
  await options.seam?.("after-fence");
  return { fence: next, intent };
}

/**
 * A controlled failure after the barrier was taken: release ONLY this
 * attempt's barrier (so a retry in the same process can resume; intent,
 * journal and fence stay), and report the failure typed without masking it.
 */
async function failedAttempt(root: string, held: { token?: string }, error: unknown): Promise<never> {
  const original = error instanceof Error ? error.message : String(error);
  let released: string | null = null;
  if (held.token !== undefined) released = await releaseBarrier(root, held.token).then(() => null, (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
  if (released === null && error instanceof ScaleDowngradeError) throw error;
  const code = error instanceof ScaleDowngradeError ? error.code : undefined;
  throw new ScaleDowngradeError("scale_downgrade_partial", released === null ? original : `${original}; and this attempt's barrier could not be released: ${released}`, { cause: original, ...(code === undefined ? {} : { causeCode: code }) });
}

/** The collector body of an indexed apply, under the maintenance acquisition. */
async function indexedBody(root: string, plan: DowngradePlanV1, expected: Phase["kind"], options: DowngradeApplyOptions, checked: { current?: boolean }): Promise<DowngradeApplyResultV1> {
  await assertNotCancelled(root, intentOf(plan).dir);
  const phase = await classify(root, plan);
  if (phase.kind !== expected) fault(`the scale-down changed from ${expected} to ${phase.kind} while the lock was taken; re-run the same apply`);
  if ((phase.kind === "fresh" || phase.kind === "bootstrapped") && checked.current !== true) {
    if (phase.kind === "bootstrapped") await retireOwnIntent(root, phase.intent);
    throw new ScaleDowngradeError("scale_downgrade_stale_plan", "the project changed since this plan was made; preview again");
  }
  const held: { token?: string } = {};
  let done: { fenced: Awaited<ReturnType<typeof fence>>; revision: number };
  try {
    const fenced = await fence(root, plan, phase, options, held);
    const phases = await runWithDowngradeAccess(root, held.token!, plan.digest, () => runFencedPhases({ root, plan, dir: fenced.intent.dir, fence: fenced.fence, seam: options.seam }));
    done = { fenced, revision: phases.revision };
  } catch (error) {
    return failedAttempt(root, held, error);
  }
  await releaseBarrier(root, held.token!);
  await retireOwnIntent(root, done.fenced.intent);
  return resultOf(plan, done.revision, done.fenced.intent.dir, phase.kind !== "fresh");
}

/**
 * Finish the cleanup of a committed scale-down: reclassified under the raw
 * project lock, then only this scale-down's own stale barrier and its exact
 * intent are touched (never a newer record, store or pending work).
 */
async function cleanupCommitted(root: string, plan: DowngradePlanV1): Promise<DowngradeApplyResultV1> {
  await acquireLockBlocking(root);
  try {
    const phase = await classify(root, plan);
    if (phase.kind !== "committed") fault(`the scale-down is ${phase.kind}, no longer committed, under the lock; re-run the same apply`);
    if (!(await committedAt(root, plan, phase.intent, phase.record, true))) fault("the committed receipt or outcome changed");
    const activation = phase.intent.fenceRevision + 1;
    if (phase.record.revision === activation) await syncPublishedDowngradeRecord(root, phase.record);
    // A replayed retirement re-establishes both parents before the barrier is touched.
    if (phase.retired) await finishRetirement(root, phase.intent);
    await removeStaleBarrierOf(root, plan.digest);
    if (!phase.retired) await retireOwnIntent(root, phase.intent);
    const later = phase.record.revision > activation ? { current: { revision: phase.record.revision, architecture: phase.record.active.architecture } } : {};
    return { ...resultOf(plan, activation, phase.intent.dir, true), ...later };
  } finally {
    await releaseLock(root);
  }
}

/** Apply (or resume) an indexed scale-down. */
async function applyIndexed(root: string, plan: DowngradePlanV1, options: DowngradeApplyOptions): Promise<DowngradeApplyResultV1> {
  await assertNotCancelled(root, intentOf(plan).dir);
  await options.seam?.("apply:after-outer-guard");
  await repairBootstrapIntent(root, plan, intentOf(plan));
  const phase = await classify(root, plan);
  if (phase.kind === "committed") return cleanupCommitted(root, plan);
  if (phase.kind === "fresh") assertUnblocked(plan);
  const checked: { current?: boolean } = {};
  const catalogs = new Map(plan.inventory.units.filter((unit) => unit.kind === "catalog").map((unit) => [unit.workspaceId!, unit.records]));
  const custody = phase.kind === "fenced"
    ? { downgradeFence: { plan: plan.digest, catalogs } }
    : { lockedCheck: async () => { await assertNotCancelled(root, intentOf(plan).dir); await lockedChecks(root, plan, options.space ?? diskPreflightIo(root), checked); } };
  return withMaintenanceLock(root, custody, () => indexedBody(root, plan, phase.kind, options, checked));
}

/** Apply a record-only scale-down (`local-large` → `local-standard`). */
async function applyRecordOnly(root: string, plan: DowngradePlanV1): Promise<DowngradeApplyResultV1> {
  assertUnblocked(plan);
  await acquireMutationLockBlocking(root, "scale");
  try {
    assertPlanCurrent(plan, await currentPlan(root, plan));
    const read = await readScaleRecord(root);
    if (read.kind !== "ok") fault("the scale record cannot be read");
    const activated = activationRecord(read.record, plan.inventory.requested, plan.inventory.target);
    await writeClassified(root, diskScaleRecordIo(root), activated, read.record);
    return resultOf(plan, activated.revision, null, false);
  } finally {
    await releaseLock(root);
  }
}

/** Apply (or resume) the scale-down `plan` (already parsed for this root) to the project at `root`. */
export async function applyScaleDowngrade(root: string, plan: DowngradePlanV1, options: DowngradeApplyOptions): Promise<DowngradeApplyResultV1> {
  if (options.readersOffline !== true) throw new ScaleDowngradeError("scale_downgrade_readers_live", "assert that no build without reader leases and no other tool reads this project (--readers-offline)");
  const canonical = await canonicalRoot(root);
  return plan.inventory.from === "local-large" ? applyRecordOnly(canonical, plan) : applyIndexed(canonical, plan, options);
}
