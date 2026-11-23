/**
 * @file src/scale/downgrade-cancel.ts
 * @description SAFE PRE-INSTALL CANCEL of an indexed scale-down (design v2,
 * with Root's three binding corrections). It returns a scale-down that has
 * moved NO authority to the incumbent `local-indexed` layout, and refuses
 * after the first move or on any doubt. It is not a rollback: a partial
 * install stays forward recovery with `--apply`.
 *
 * FENCED (rows F0, F1), under the maintenance acquisition with this plan's own
 * fence custody, all with the SAME raw project lock held throughout:
 * reclassify; inspect the barrier read-only; the no-move proof
 * (`./downgrade-cancel-proof.ts`); the create-only cancel intent (F0); the
 * then, AFTER that durable write and its seam, the whole state is observed
 * and proven AGAIN (own intent, own fence, bound cancel intent, incumbent
 * stores and pins, staging evidence, no move, captured priors); ONE
 * compare-and-swap from the fence to the fence's successor with nothing
 * pending (the incumbent stays active and the fence's planned estimate stays
 * on the record: `estimate: "planned-kept"`); then, still under that lock,
 * the receipt, the intent retirement and only then removal of a stale barrier
 * of this plan. No unlock, no second gate.
 *
 * RESUMED proven cleanup (F2, F5) and the BOOTSTRAPPED cancel (B0 to B4)
 * take the raw project lock on their own and reclassify under it; they never
 * take maintenance custody, so later pending work is never treated as this
 * plan's state. A bootstrapped cancel never writes the record, so the
 * estimate on it is whatever it was (`estimate: "unchanged"`). A proven
 * replay of a completed cancel (F6, B5) only finishes removing a stale
 * barrier of this plan, which an interruption after the intent retirement
 * can leave (a stale barrier blocks no read, but it is this cancel's to
 * remove); a live, foreign or unreadable barrier is never touched.
 *
 * F3 (a record past the cancel revision and no receipt) FAILS CLOSED; so does
 * every other unproven state. Nothing is ever deleted: plan, staging attempts,
 * staged files, intent and cancel leaves stay in the evidence directory.
 */

import path from "node:path";
import { createDowngradeIntent } from "../segments/downgrade-access.js";
import { createHash } from "node:crypto";
import { withMaintenanceLock } from "../indexed/maintenance-lock.js";
import { canonicalRoot } from "../segments/reader-lease.js";
import { durableTempPath } from "../utils/atomic-write-no-replace-durable.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import type { RequestedScaleV1 } from "./contracts.js";
import type { ScaleRecordV2 } from "./contracts-v2.js";
import { repairBootstrapIntent } from "./downgrade-bootstrap-evidence.js";
import { intentOf } from "./downgrade-apply.js";
import { removeStaleBarrierOf } from "./downgrade-barrier.js";
import { ESTIMATE_OF_PHASE, isSameCapture } from "./downgrade-cancel-bind.js";
import { evidenceAttempts, notCancellable } from "./downgrade-cancel-evidence.js";
import { cancelIntentSha256, observeCancel, type ObservedCancel } from "./downgrade-cancel-observe.js";
import { assertPriorsUnchanged, inspectBarrier, proveNoMove } from "./downgrade-cancel-proof.js";
import { classifyCancel, type CancelRow } from "./downgrade-cancel-state.js";
import { finishRetirement, retireOwnIntent } from "./downgrade-commit.js";
import { mayHaveEvidenceAlias } from "./downgrade-evidence-write.js";
import { ScaleDowngradeError, type DowngradeSeamFn } from "./downgrade-contracts.js";
import { CANCEL_LEAF, CANCEL_READY_NAMES, CANCEL_RECEIPT_LEAF, CANCEL_RECEIPT_READY_NAMES, checkpointCancelIntent, checkpointCancelReceipt, readCancelIntent, recordCancelIntent, recordCancelReceipt, type CancelIntentV1, type CancelReceiptV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { syncPublishedDowngradeRecord, writeClassified } from "./downgrade-records.js";
import { diskScaleRecordIo, readScaleRecord } from "./record.js";
import { serializeAnyScaleRecord } from "./record-v2-schema.js";

/** How a cancel runs. */
export interface DowngradeCancelOptions {
  /** The operator's assertion that no build without reader leases, and no other tool, reads the project. Required. */
  readonly readersOffline: boolean;
  /** TEST SEAM: announced after each durable checkpoint. */
  readonly seam?: DowngradeSeamFn;
}

/** What a cancel did. */
export interface DowngradeCancelResultV1 {
  readonly plan: string;
  readonly phase: "fenced" | "bootstrapped";
  /** Fenced: the revision of the record the cancel wrote. Bootstrapped: null (no record was written). */
  readonly cancelRevision: number | null;
  /** The retained evidence directory. */
  readonly dir: string;
  /**
   * Fenced: `planned-kept`, the fence's planned (smaller) estimate stays on the
   * record the cancel wrote. Bootstrapped: `unchanged`, the cancel wrote no
   * record, so the estimate is what the record already held.
   */
  readonly estimate: "planned-kept" | "unchanged";
  /** The estimate on the scale record when this call finished (on a replay it may reflect later work); null when unreadable. */
  readonly currentEstimate: RequestedScaleV1 | null;
  /** True when this call finished an earlier interrupted cancel. */
  readonly resumed: boolean;
  /**
   * True when the cancel had already completed earlier: this call wrote no
   * cancel leaf and no record (it may have removed a stale barrier of this
   * plan, finishing that cancel's cleanup). The earlier cancel's effects are
   * historical; the record may have changed since.
   */
  readonly alreadyCancelled: boolean;
  /** Bootstrapped only: a newer record found when the cancel completed (it was not written by the cancel). */
  readonly laterRecord: { readonly revision: number; readonly architecture: string } | null;
}

/** What a refusal after the record compare-and-swap must say: the transition already happened. */
const COMMITTED_EFFECTS = "The scale record had ALREADY been changed to the cancel record (fence removed, the incumbent layout active); only the receipt and the intent retirement are outstanding: inspect the cancel intent, then re-run the same cancel.";
/** What a refusal in a bootstrapped cancel must say: it never writes the record. */
const NO_RECORD_EFFECTS = "No scale record was written by this cancel.";

/** Refuse with a partial fault: nothing more was changed; every leaf is retained. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** The result of a cancel that completed (or had), with the estimate read from the record as it is now. */
async function resultOf(root: string, plan: DowngradePlanV1, cancel: CancelIntentV1, flags: { resumed: boolean; alreadyCancelled: boolean; laterRecord: DowngradeCancelResultV1["laterRecord"] }): Promise<DowngradeCancelResultV1> {
  const read = await readScaleRecord(root);
  return { plan: plan.digest, phase: cancel.phase, cancelRevision: cancel.cancelRevision, dir: intentOf(plan).dir, estimate: ESTIMATE_OF_PHASE[cancel.phase],
    currentEstimate: read.kind === "ok" ? read.record.requested : null, ...flags };
}

/** Refuse every row that is not acted on, with its reason. */
function refuseRow(row: CancelRow): never {
  if (row === "fresh") throw new ScaleDowngradeError("scale_downgrade_nothing_to_cancel", "this plan has no scale-down in progress and no cancel receipt");
  if (row === "foreign") throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "another scale-down's intent is in place; cancel or apply that plan");
  if (row === "F3") throw new ScaleDowngradeError("scale_downgrade_cancel_unproven", "a cancel intent exists but the record is past its cancel revision and there is no receipt; nothing proves this cancel wrote it, so nothing was written and every leaf is kept for inspection");
  if (row === "not-pre-install") notCancellable("P2", "the record is neither this plan's fence nor its original record (the scale-down may have committed: resume it with --apply)");
  return fault(`the cancel state ${row} is not one this cancel can act on (malformed, unbound or unexpected evidence); every leaf is kept for inspection`);
}

/** Run `body` under the raw project lock (never nested in another acquisition). */
async function underRawLock<T>(root: string, body: () => Promise<T>): Promise<T> {
  await acquireLockBlocking(root);
  try {
    return await body();
  } finally {
    await releaseLock(root);
  }
}

/**
 * The SHA-256 of the cancel intent's exact bytes, only while those bytes are
 * still exactly `cancel` (read, parsed and bound, with the bytes unchanged
 * across the read); otherwise a typed refusal that states what has already
 * happened (`effects`). The receipt never commits to a changed leaf.
 */
async function attestedCancelSha256(root: string, plan: DowngradePlanV1, cancel: CancelIntentV1, effects: string): Promise<string> {
  const dir = intentOf(plan).dir;
  const before = await cancelIntentSha256(root, dir);
  const now = await readCancelIntent(root, dir, plan.digest);
  const after = await cancelIntentSha256(root, dir);
  if (before === null || before !== after || !isSameCapture(cancel, now, cancel.recordSha256)) {
    return fault(`${dir}/${CANCEL_LEAF} is no longer exactly the cancel intent this cancel proved; no receipt was written and every leaf is kept. ${effects}`);
  }
  return before;
}

/**
 * The cleanup of a PROVEN cancel, with the raw project lock already held by
 * the caller: write the bound receipt (unless it exists) attesting exactly the
 * captured cancel intent, retire this plan's exact intent, then remove a stale
 * barrier of this plan. `effects` says what already happened, for an honest
 * refusal if the cancel intent changed.
 */
async function completeHeld(root: string, plan: DowngradePlanV1, cancel: CancelIntentV1, flags: { writeReceipt: boolean; laterRecord: DowngradeCancelResultV1["laterRecord"]; effects: string; seam?: DowngradeSeamFn }): Promise<void> {
  const intent = intentOf(plan);
  await createDowngradeIntent(root, intent, true);
  if (flags.writeReceipt) {
    const sha = await attestedCancelSha256(root, plan, cancel, flags.effects);
    await recordCancelReceipt(root, intent.dir, receiptBody(cancel, sha, flags.laterRecord));
    await flags.seam?.("cancel:after-receipt");
  }
  await retireOwnIntent(root, intent);
  await flags.seam?.("cancel:after-retire");
  await removeStaleBarrierOf(root, plan.digest);
}

/** Recreate the exact receipt writer value from the independently proved outcome. */
function receiptBody(cancel: CancelIntentV1, sha: string, laterRecord: DowngradeCancelResultV1["laterRecord"]): Omit<CancelReceiptV1, "format" | "version"> {
  return { plan: cancel.plan, phase: cancel.phase, fenceRevision: cancel.fenceRevision, cancelRevision: cancel.cancelRevision,
    recordSha256: cancel.recordSha256, cancelIntentSha256: sha, estimate: ESTIMATE_OF_PHASE[cancel.phase], laterRecord };
}

/** The record the fenced cancel writes over `fence`, and the SHA-256 of its exact bytes. */
function cancelRecordOf(fence: ScaleRecordV2): { next: ScaleRecordV2; sha256: string } {
  const next: ScaleRecordV2 = { ...fence, revision: fence.revision + 1, pending: null };
  return { next, sha256: createHash("sha256").update(serializeAnyScaleRecord(next)).digest("hex") };
}

/** The cancel intent of a fenced cancel: written now (F0), or the existing one, which must declare exactly this record outcome (F1). */
async function fencedIntent(root: string, plan: DowngradePlanV1, observed: ObservedCancel, outcome: { fenceRevision: number; sha256: string }, options: DowngradeCancelOptions): Promise<CancelIntentV1> {
  const intent = intentOf(plan);
  if (observed.cancel !== null) {
    if (observed.cancel.recordSha256 !== outcome.sha256 || observed.cancel.fenceRevision !== outcome.fenceRevision) fault(`${intent.dir}/${CANCEL_LEAF} declares another record outcome`);
    return observed.cancel;
  }
  const proof = await proveNoMove(root, intent.dir, plan, CANCEL_READY_NAMES);
  const body = { plan: plan.digest, phase: "fenced" as const, fenceRevision: outcome.fenceRevision, cancelRevision: outcome.fenceRevision + 1, recordSha256: outcome.sha256, priors: proof.priors };
  await recordCancelIntent(root, intent.dir, body);
  await options.seam?.("cancel:after-intent");
  return { format: "llmwiki-scale-downgrade-cancel", version: 1, ...body };
}

/** The fenced cancel body, inside the maintenance acquisition (its raw lock is held for all of it). */
async function fencedBody(root: string, plan: DowngradePlanV1, expected: CancelRow, options: DowngradeCancelOptions): Promise<DowngradeCancelResultV1> {
  const observed = await observeCancel(root, plan, intentOf(plan));
  const row = classifyCancel(observed.observation);
  if (row !== expected || observed.record === null) fault(`the cancel changed from ${expected} to ${row} while the lock was taken; re-run the same cancel`);
  // Read-only: a live or foreign barrier refuses; a stale one of this plan is removed only after the record is proven (completeHeld).
  await inspectBarrier(root, plan.digest);
  await createDowngradeIntent(root, intentOf(plan), true);
  const fence = observed.record as ScaleRecordV2;
  await syncPublishedDowngradeRecord(root, fence);
  const outcome = cancelRecordOf(fence);
  // F0 proves inside fencedIntent before its durable write; F1 writes nothing before the revalidation below.
  const cancel = await fencedIntent(root, plan, observed, { fenceRevision: fence.revision, sha256: outcome.sha256 }, options);
  await revalidateBeforeCas(root, plan, cancel, outcome.sha256);
  await writeClassified(root, diskScaleRecordIo(root), outcome.next, fence);
  await options.seam?.("cancel:after-record");
  await completeHeld(root, plan, cancel, { writeReceipt: true, laterRecord: null, effects: COMMITTED_EFFECTS, seam: options.seam });
  return resultOf(root, plan, cancel, { resumed: row === "F1", alreadyCancelled: false, laterRecord: null });
}

/**
 * The C7 revalidation, after the durable cancel intent and its seam and right
 * before the compare-and-swap: the state must still be F1 and the re-read,
 * bound cancel intent must be EXACTLY the captured one with the expected
 * record outcome (`isSameCapture`); then the whole no-move proof and the
 * captured priors must still hold. The record CAS alone checks only the record.
 */
async function revalidateBeforeCas(root: string, plan: DowngradePlanV1, cancel: CancelIntentV1, recordSha256: string): Promise<void> {
  const again = await observeCancel(root, plan, intentOf(plan));
  if (classifyCancel(again.observation) !== "F1" || !isSameCapture(cancel, again.cancel, recordSha256)) {
    fault("the fence or the cancel intent changed after the cancel intent was written; the scale record was NOT changed and every leaf is kept");
  }
  await proveNoMove(root, intentOf(plan).dir, plan, [CANCEL_LEAF]);
  await assertPriorsUnchanged(root, cancel.priors);
  await checkpointCancelIntent(root, intentOf(plan).dir, cancel);
}

/** The bootstrapped proof: nothing was ever staged, so the evidence directory holds only the plan and this cancel's own leaves. */
async function proveBootstrapped(root: string, plan: DowngradePlanV1, ownLeaves: readonly string[]): Promise<void> {
  const attempts = await evidenceAttempts(root, intentOf(plan).dir, plan, ownLeaves);
  if (attempts.length > 0) notCancellable("P7", "a staging attempt exists, so this scale-down fenced");
}

/** The newer record a B2 receipt names, re-derived from the record observed under the raw lock; null for every other row. */
function laterRecordOf(row: CancelRow, observed: ObservedCancel): DowngradeCancelResultV1["laterRecord"] {
  return row === "B2" && observed.record !== null ? { revision: observed.record.revision, architecture: observed.record.active.architecture } : null;
}

/** Bootstrapped B0 to B2 under the raw lock: prove, write the cancel intent if needed (never the record), then complete. */
async function bootstrappedHeld(root: string, plan: DowngradePlanV1, row: CancelRow, observed: ObservedCancel, options: DowngradeCancelOptions): Promise<DowngradeCancelResultV1> {
  const intent = intentOf(plan);
  await inspectBarrier(root, plan.digest);
  // B1 and B2 may meet their own unfinished receipt publication; its bytes are proved by the receipt writer.
  const ownLeaves = row === "B0" ? CANCEL_READY_NAMES : [CANCEL_LEAF, ...CANCEL_RECEIPT_READY_NAMES];
  await proveBootstrapped(root, plan, ownLeaves);
  await createDowngradeIntent(root, intent, true);
  let cancel = observed.cancel;
  if (cancel === null) {
    const body = { plan: plan.digest, phase: "bootstrapped" as const, fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] };
    await recordCancelIntent(root, intent.dir, body);
    await options.seam?.("cancel:after-intent");
    cancel = { format: "llmwiki-scale-downgrade-cancel", version: 1, ...body };
  }
  await checkpointCancelIntent(root, intent.dir, cancel);
  const later = laterRecordOf(row, observed);
  await completeHeld(root, plan, cancel, { writeReceipt: true, laterRecord: later, effects: NO_RECORD_EFFECTS, seam: options.seam });
  return resultOf(root, plan, cancel, { resumed: row !== "B0", alreadyCancelled: false, laterRecord: later });
}

/** The raw-lock rows of a bootstrapped cancel (B0 to B2), handled by {@link bootstrappedHeld}. */
const BOOTSTRAPPED_ROWS: ReadonlySet<CancelRow> = new Set<CancelRow>(["B0", "B1", "B2"]);
/** The proven-replay rows: the cancel already completed. */
const REPLAY_ROWS: ReadonlySet<CancelRow> = new Set<CancelRow>(["F6", "B5"]);
/** The resumable raw-lock rows, each with its completion effects: F2 and F5 had changed the record, B4 never did. */
const RESUME_EFFECTS: ReadonlyMap<CancelRow, string> = new Map<CancelRow, string>([["F2", COMMITTED_EFFECTS], ["F5", COMMITTED_EFFECTS], ["B4", NO_RECORD_EFFECTS]]);

/** A raw-lock row with a bound cancel intent, and the later record its receipt names (if any). */
interface HeldRow {
  readonly row: CancelRow;
  readonly cancel: CancelIntentV1;
  readonly laterRecord: DowngradeCancelResultV1["laterRecord"];
}

/**
 * Proven replay (F6, B5): already cancelled. The row was classified under this
 * raw lock from the exact retired intent and a bound receipt; first sync both
 * parents of that retirement again (its rename may have outlived a failed
 * checkpoint), then finish only an identity-proven stale barrier of THIS plan.
 */
async function replayHeld(root: string, plan: DowngradePlanV1, held: HeldRow): Promise<DowngradeCancelResultV1> {
  await finishRetirement(root, intentOf(plan));
  // An interruption after the retirement can leave one.
  await removeStaleBarrierOf(root, plan.digest);
  return resultOf(root, plan, held.cancel, { resumed: false, alreadyCancelled: true, laterRecord: held.laterRecord });
}

/** Resume F2, F5 or B4: inspect the barrier, then complete with the row's effects (a receipt is written only for F2). */
async function resumeHeld(root: string, plan: DowngradePlanV1, held: HeldRow, effects: string, options: DowngradeCancelOptions): Promise<DowngradeCancelResultV1> {
  await inspectBarrier(root, plan.digest);
  await completeHeld(root, plan, held.cancel, { writeReceipt: held.row === "F2", laterRecord: held.laterRecord, effects, seam: options.seam });
  return resultOf(root, plan, held.cancel, { resumed: true, alreadyCancelled: false, laterRecord: held.laterRecord });
}

/** Re-establish durable evidence in order before resuming a raw-lock row. */
async function checkpointRawResume(root: string, plan: DowngradePlanV1, held: HeldRow, observed: ObservedCancel): Promise<void> {
  await checkpointCancelIntent(root, intentOf(plan).dir, held.cancel);
  if (observed.receipt !== null) await checkpointCancelReceipt(root, intentOf(plan).dir, observed.receipt);
  if (held.row === "F2") {
    if (observed.record === null) return refuseRow(held.row);
    await syncPublishedDowngradeRecord(root, observed.record);
  }
}

/** Every raw-lock row, reclassified under the lock: bootstrapped, then (with a cancel intent) replay or resume; anything else refuses. */
async function rawLockedBody(root: string, plan: DowngradePlanV1, options: DowngradeCancelOptions): Promise<DowngradeCancelResultV1> {
  const observed = await observeCancel(root, plan, intentOf(plan));
  const row = classifyCancel(observed.observation);
  if (BOOTSTRAPPED_ROWS.has(row)) return bootstrappedHeld(root, plan, row, observed, options);
  if (observed.cancel === null) return refuseRow(row);
  const held: HeldRow = { row, cancel: observed.cancel, laterRecord: observed.receipt?.laterRecord ?? null };
  if (REPLAY_ROWS.has(row)) return replayHeld(root, plan, held);
  const effects = RESUME_EFFECTS.get(row);
  if (effects === undefined) return refuseRow(row);
  await checkpointRawResume(root, plan, held, observed);
  return resumeHeld(root, plan, held, effects, options);
}

/** Reconstruct the original pre-CAS cancel capture while the fence or original is still exact. */
async function repairCancelIntentAlias(root: string, plan: DowngradePlanV1, basis: ObservedCancel): Promise<void> {
  const intent = intentOf(plan);
  const row = classifyCancel(basis.observation);
  const leaves = [CANCEL_LEAF, durableTempPath(CANCEL_LEAF)];
  if (row === "F0" && basis.record !== null && basis.record.version !== 1) {
    const outcome = cancelRecordOf(basis.record);
    const proof = await proveNoMove(root, intent.dir, plan, leaves);
    await checkpointCancelIntent(root, intent.dir, { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: plan.digest,
      phase: "fenced", fenceRevision: intent.fenceRevision, cancelRevision: outcome.next.revision, recordSha256: outcome.sha256, priors: proof.priors });
  } else if (row === "B0") {
    await proveBootstrapped(root, plan, leaves);
    await checkpointCancelIntent(root, intent.dir, { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: plan.digest,
      phase: "bootstrapped", fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] });
  } else {
    fault("the incumbent no longer proves the original cancel capture; the reserved alias was kept");
  }
}

/**
 * Reconstruct a receipt only where the exact recorded outcome fixes every
 * field. B2's later record is re-derived under the lock; if the record moved
 * again, the bytes differ, the exact-byte checkpoint refuses and the alias is kept.
 */
async function repairCancelReceiptAlias(root: string, plan: DowngradePlanV1, basis: ObservedCancel): Promise<void> {
  const intent = intentOf(plan);
  const row = classifyCancel(basis.observation);
  const cancel = basis.cancel;
  if (cancel === null || (row !== "F2" && row !== "B1" && row !== "B2")) fault("the exact cancel receipt is no longer reconstructible; the reserved alias was kept");
  if (row !== "F2") await proveBootstrapped(root, plan, [CANCEL_LEAF, CANCEL_RECEIPT_LEAF, durableTempPath(CANCEL_RECEIPT_LEAF)]);
  const sha = await attestedCancelSha256(root, plan, cancel, "The reserved alias was kept.");
  await checkpointCancelReceipt(root, intent.dir, { format: "llmwiki-scale-downgrade-cancel-receipt", version: 1, ...receiptBody(cancel, sha, laterRecordOf(row, basis)) });
}

/** Restore at most one owned cancel alias under the raw lock, then dispatch normally. */
async function repairCancelAlias(root: string, plan: DowngradePlanV1): Promise<void> {
  const intent = intentOf(plan);
  const cancel = path.posix.join(intent.dir, CANCEL_LEAF);
  const receipt = path.posix.join(intent.dir, CANCEL_RECEIPT_LEAF);
  if (!(await mayHaveEvidenceAlias(root, cancel)) && !(await mayHaveEvidenceAlias(root, receipt))) return;
  await underRawLock(root, async () => {
    const cancelAlias = await mayHaveEvidenceAlias(root, cancel);
    const receiptAlias = await mayHaveEvidenceAlias(root, receipt);
    if (!cancelAlias && !receiptAlias) return;
    if (cancelAlias && receiptAlias) fault("both cancel leaves have reserved aliases; neither was touched");
    const basis = await observeCancel(root, plan, intent, cancelAlias ? "cancel" : "receipt");
    await inspectBarrier(root, plan.digest);
    if (cancelAlias) await repairCancelIntentAlias(root, plan, basis);
    else await repairCancelReceiptAlias(root, plan, basis);
  });
}

/** The workspace catalog record counts the plan froze, for the maintenance bundle leg under this plan's own fence. */
function frozenCatalogs(plan: DowngradePlanV1): Map<string, number> {
  return new Map(plan.inventory.units.filter((unit) => unit.kind === "catalog").map((unit) => [unit.workspaceId!, unit.records]));
}

/**
 * Cancel (or finish cancelling) the indexed scale-down `plan` (already parsed
 * for this root) at `root`, before it moved anything. See the file comment.
 */
export async function cancelScaleDowngrade(root: string, plan: DowngradePlanV1, options: DowngradeCancelOptions): Promise<DowngradeCancelResultV1> {
  if (options.readersOffline !== true) throw new ScaleDowngradeError("scale_downgrade_readers_live", "assert that no build without reader leases and no other tool reads this project (--readers-offline)");
  if (plan.inventory.from !== "local-indexed") notCancellable("P0", "a scale-down from local-large changes only the record in one step; there is nothing to cancel");
  const canonical = await canonicalRoot(root);
  await repairBootstrapIntent(canonical, plan, intentOf(plan));
  await repairCancelAlias(canonical, plan);
  const row = classifyCancel((await observeCancel(canonical, plan, intentOf(plan))).observation);
  if (row === "F0" || row === "F1") {
    return withMaintenanceLock(canonical, { downgradeFence: { plan: plan.digest, catalogs: frozenCatalogs(plan) } }, () => fencedBody(canonical, plan, row, options));
  }
  return underRawLock(canonical, () => rawLockedBody(canonical, plan, options));
}
