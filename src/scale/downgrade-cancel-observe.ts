/**
 * @file src/scale/downgrade-cancel-observe.ts
 * @description What a pre-install cancel OBSERVES, read-only, for the
 * classifier (`./downgrade-cancel-state.ts`): the bootstrap intent, the
 * retired intent, the cancel intent and receipt, and the scale record
 * relative to this plan.
 *
 * - The cancel intent is BOUND to the held plan and intent before anything
 *   else (`./downgrade-cancel-bind.ts`); an unbound one refuses.
 * - A receipt counts only when it is BOUND to that cancel intent, to the held
 *   plan and to the cancel intent's exact bytes. File existence alone is
 *   never enough. A malformed leaf refuses (it is kept, never rewritten).
 * - The record is always PARSED. It is `original` when its exact bytes are
 *   the intent's original record AND it is that original indexed record;
 *   `fence` when it is exactly this plan's fence (pending revision, plan,
 *   target, `local-indexed` active, the plan's estimate); `expected-cancel`
 *   when a fenced cancel intent exists, the record's exact bytes are the ones
 *   it declared and its content is the fence's successor; `later` when a fenced cancel
 *   intent exists and the record is past that revision (which proves nothing);
 *   `never-fenced-later` only for a BOOTSTRAPPED cancel intent, when the
 *   record moved on in a way only possible if this scale-down never fenced (a
 *   newer version 2 or 3 record, `local-indexed` active, nothing pending for a
 *   scale-down, `.llmwiki/indexed` present, and the evidence directory holding
 *   exactly `plan.json` and the cancel intent, plus only the exact reserved
 *   names this cancel's own unfinished receipt publication can leave: its
 *   `.tmp` and `.writing` scratch, or, for the alias-repair basis that omits
 *   the receipt, the receipt and its `.tmp` alias); `other` otherwise. The
 *   receipt writer and alias repair then prove those names' exact bytes.
 */

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { INDEXED_DIR } from "../segments/contracts.js";
import { readDowngradeIntent, type DowngradeIntentV1 } from "../segments/downgrade-access.js";
import { SCALE_RECORD_FILE } from "./contracts.js";
import type { ScaleRecord } from "./contracts-v2.js";
import { bindCancelIntent, isExpectedCancelRecord, isOwnFence, isOwnOriginal, receiptBinds } from "./downgrade-cancel-bind.js";
import type { CancelObservation, RecordObservation } from "./downgrade-cancel-state.js";
import { isRetiredIntent } from "./downgrade-commit.js";
import { identityAt, leafDigest } from "./downgrade-fs.js";
import { durableTempPath } from "../utils/atomic-write-no-replace-durable.js";
import { CANCEL_LEAF, CANCEL_RECEIPT_LEAF, CANCEL_RECEIPT_READY_NAMES, readCancelIntent, readCancelReceipt, type CancelIntentV1, type CancelReceiptV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { readScaleRecord } from "./record.js";

/** An observation together with the leaves it was made from. */
export interface ObservedCancel {
  readonly observation: CancelObservation;
  readonly cancel: CancelIntentV1 | null;
  readonly receipt: CancelReceiptV1 | null;
  readonly record: ScaleRecord | null;
}

/** SHA-256 of the cancel intent's exact bytes, or null when it is not a readable single-link file. */
export async function cancelIntentSha256(root: string, dir: string): Promise<string | null> {
  const found = await leafDigest(root, path.posix.join(dir, CANCEL_LEAF));
  return found.kind === "ok" ? found.sha256 : null;
}

/** Whether `receipt` is bound to the (already bound) `cancel`, the held intent and the cancel intent's exact bytes. */
async function isBound(root: string, intent: DowngradeIntentV1, receipt: CancelReceiptV1, cancel: CancelIntentV1 | null): Promise<boolean> {
  return cancel !== null && receiptBinds(receipt, cancel, intent, await cancelIntentSha256(root, intent.dir));
}

/** The two leaves every never-fenced evidence directory holds. */
const REQUIRED_NEVER_FENCED = ["plan.json", CANCEL_LEAF] as const;

/** The receipt names a never-fenced listing may also hold: the unfinished publication's scratch, or the alias-repair pair. */
function ownReceiptNames(omitForAliasProof: "cancel" | "receipt" | undefined): readonly string[] {
  return omitForAliasProof === "receipt" ? [CANCEL_RECEIPT_LEAF, durableTempPath(CANCEL_RECEIPT_LEAF)] : CANCEL_RECEIPT_READY_NAMES;
}

/** Whether the evidence directory holds `plan.json`, the cancel intent and at most the given receipt names, all files. */
async function onlyPlanAndCancel(root: string, dir: string, receiptNames: readonly string[]): Promise<boolean> {
  const listing = await listConfinedDirBounded(root, dir, REQUIRED_NEVER_FENCED.length + receiptNames.length);
  if (listing.kind !== "ok" || listing.entries.some((entry) => entry.kind !== "file")) return false;
  const names = listing.entries.map((entry) => entry.name);
  const known = names.every((name) => (REQUIRED_NEVER_FENCED as readonly string[]).includes(name) || receiptNames.includes(name));
  return known && REQUIRED_NEVER_FENCED.every((name) => names.includes(name));
}

/** The positive never-fenced proof of a bootstrapped cancel whose record moved on (see the file comment). */
async function neverFencedLater(root: string, basis: RecordBasis, record: ScaleRecord): Promise<boolean> {
  const { intent } = basis;
  if (record.version === 1 || record.revision <= intent.originalRevision) return false;
  if (record.active.architecture !== "local-indexed" || record.pending?.kind === "downgrade") return false;
  if ((await identityAt(root, INDEXED_DIR))?.kind !== "directory") return false;
  return onlyPlanAndCancel(root, intent.dir, basis.receiptNames);
}

/** What a readable record is classified against: this plan, its intent, any cancel intent, the record bytes' digest and the admitted receipt names. */
interface RecordBasis {
  readonly plan: DowngradePlanV1;
  readonly intent: DowngradeIntentV1;
  readonly cancel: CancelIntentV1 | null;
  readonly sha: string | null;
  readonly receiptNames: readonly string[];
}

/** A fenced cancel's record: its exact expected cancel record, a record past the cancel revision, or other. */
function fencedCancelState(record: ScaleRecord, basis: RecordBasis, cancel: CancelIntentV1, cancelRevision: number): RecordObservation {
  if (basis.sha === cancel.recordSha256 && isExpectedCancelRecord(record, basis.plan, basis.intent)) return "expected-cancel";
  return record.revision > cancelRevision ? "later" : "other";
}

/** A record that is neither this plan's original nor its fence, classified by the cancel intent's phase. */
async function cancelPhaseState(root: string, record: ScaleRecord, basis: RecordBasis): Promise<RecordObservation> {
  const { cancel } = basis;
  if (cancel?.phase === "fenced" && cancel.cancelRevision !== null) return fencedCancelState(record, basis, cancel, cancel.cancelRevision);
  if (cancel?.phase === "bootstrapped" && (await neverFencedLater(root, basis, record))) return "never-fenced-later";
  return "other";
}

/** A readable record, in order: this plan's exact original, its own fence, then by the cancel intent's phase. */
async function classifyRecord(root: string, record: ScaleRecord, basis: RecordBasis): Promise<RecordObservation> {
  if (basis.sha === basis.intent.originalRecordSha256 && isOwnOriginal(record, basis.intent)) return "original";
  if (isOwnFence(record, basis.plan, basis.intent)) return "fence";
  return cancelPhaseState(root, record, basis);
}

/** The record relative to this plan, its intent and any cancel intent (its bytes are digested before it is read). */
async function recordState(root: string, basis: Omit<RecordBasis, "sha">): Promise<{ state: RecordObservation; record: ScaleRecord | null }> {
  const bytes = await leafDigest(root, SCALE_RECORD_FILE);
  const sha = bytes.kind === "ok" ? bytes.sha256 : null;
  const read = await readScaleRecord(root);
  if (read.kind !== "ok") return { state: "other", record: null };
  return { state: await classifyRecord(root, read.record, { ...basis, sha }), record: read.record };
}

/**
 * Observe normally. Under the raw lock, alias repair may omit just its
 * prospective leaf to derive an independent basis. That observation cannot
 * authorize a record change or cleanup and must be followed by a strict read.
 */
export async function observeCancel(root: string, plan: DowngradePlanV1, intent: DowngradeIntentV1, omitForAliasProof?: "cancel" | "receipt"): Promise<ObservedCancel> {
  const read = await readDowngradeIntent(root);
  const intentState = read.kind === "ok" ? (isDeepStrictEqual(read.intent, intent) ? "own" : "other") : read.kind === "absent" ? "absent" : "unreadable";
  const cancel = omitForAliasProof === "cancel" ? null : await readCancelIntent(root, intent.dir, plan.digest);
  if (cancel !== null) bindCancelIntent(cancel, plan, intent);
  const receipt = omitForAliasProof === "receipt" ? null : await readCancelReceipt(root, intent.dir, plan.digest);
  const bound = receipt === null ? null : (await isBound(root, intent, receipt, cancel)) ? "bound" : "unbound";
  const { state, record } = await recordState(root, { plan, intent, cancel, receiptNames: ownReceiptNames(omitForAliasProof) });
  const observation: CancelObservation = { intent: intentState, retired: await isRetiredIntent(root, intent), record: state, cancel: cancel?.phase ?? null, receipt: bound };
  return { observation, cancel, receipt, record };
}
