/**
 * @file src/scale/downgrade-cancel-bind.ts
 * @description BINDING of a pre-install cancel's evidence to the HELD plan
 * and its derived intent, before anything is classified (Root review of
 * checkpoint 14, item 1). A journal leaf that is merely well formed, or that
 * agrees only with itself, proves nothing.
 *
 * - A cancel intent must name exactly the intent's fence revision. A fenced
 *   one must name `fenceRevision + 1` and list exactly the plan's priors, in
 *   order, by path and digest, with an identity exactly when the prior is
 *   present. A bootstrapped one must name no cancel revision, commit to the
 *   intent's ORIGINAL record digest, and list no priors.
 * - A receipt must agree with the bound cancel intent AND the held plan:
 *   revisions, record commitment, the estimate outcome of its phase, a later
 *   record only for a bootstrapped cancel, and the exact cancel-intent bytes.
 * - Records are judged as parsed records, never by hash alone:
 *   the ORIGINAL is the intent's original revision with `local-indexed`
 *   active and no scale-down pending; this plan's FENCE carries its pending
 *   revision, plan and target, `local-indexed` active and the plan's requested
 *   estimate; the EXPECTED CANCEL record is the fence's successor with nothing
 *   pending, `local-indexed` active and that same estimate.
 * Every mismatch refuses `scale_downgrade_partial` with nothing written.
 *
 * EXACT CAPTURE (`isSameCapture`). Before the record changes, and before a
 * receipt attests a cancel, the cancel intent on disk must be EXACTLY the one
 * the proof captured (deep equality of the whole intent, priors and their
 * identities included), and it must declare the expected record outcome. A
 * same-plan, same-outcome replacement with other prior identities is not the
 * capture that was checked.
 */

import { isDeepStrictEqual } from "node:util";
import type { DowngradeIntentV1 } from "../segments/downgrade-access.js";
import type { ScaleRecord } from "./contracts-v2.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";
import type { CancelIntentV1, CancelReceiptV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";

/** The estimate outcome of each phase: a fenced cancel writes the fence's estimate onward; a bootstrapped one writes no record. */
export const ESTIMATE_OF_PHASE = { fenced: "planned-kept", bootstrapped: "unchanged" } as const;

/** Refuse evidence that does not bind to the held plan; nothing was written. */
function unbound(what: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", `the cancel ${what} does not bind to the held plan and its intent; nothing was written and every leaf is kept for inspection`);
}

/** Whether the cancel intent's priors are exactly the plan's, in order, with an identity exactly for a present prior. */
function priorsBind(cancel: CancelIntentV1, plan: DowngradePlanV1): boolean {
  const expected = plan.inventory.priors;
  return cancel.priors.length === expected.length && cancel.priors.every((prior, at) => prior.relPath === expected[at]!.relPath
    && prior.sha256 === expected[at]!.sha256 && (prior.sha256 === null) === (prior.identity === null));
}

/** Refuse a cancel intent that does not bind to the held plan and its intent (see the file comment). */
export function bindCancelIntent(cancel: CancelIntentV1, plan: DowngradePlanV1, intent: DowngradeIntentV1): void {
  if (cancel.plan !== plan.digest || cancel.fenceRevision !== intent.fenceRevision) unbound("intent's plan or fence revision");
  if (cancel.phase === "fenced") {
    if (cancel.cancelRevision !== intent.fenceRevision + 1) unbound("intent's cancel revision");
    if (!priorsBind(cancel, plan)) unbound("intent's prior files");
    return;
  }
  if (cancel.cancelRevision !== null || cancel.recordSha256 !== intent.originalRecordSha256 || cancel.priors.length !== 0) unbound("intent's bootstrapped commitment");
}

/** Whether a receipt agrees with the bound cancel intent, the held plan and the exact cancel-intent bytes (`cancelSha256`). */
export function receiptBinds(receipt: CancelReceiptV1, cancel: CancelIntentV1, intent: DowngradeIntentV1, cancelSha256: string | null): boolean {
  const same = receipt.plan === cancel.plan && receipt.phase === cancel.phase && receipt.fenceRevision === intent.fenceRevision
    && receipt.fenceRevision === cancel.fenceRevision && receipt.cancelRevision === cancel.cancelRevision && receipt.recordSha256 === cancel.recordSha256;
  const outcome = receipt.estimate === ESTIMATE_OF_PHASE[cancel.phase] && (cancel.phase === "bootstrapped" || receipt.laterRecord === null);
  return same && outcome && cancelSha256 !== null && receipt.cancelIntentSha256 === cancelSha256;
}

/** Whether `observed` is exactly the captured cancel intent and declares `recordSha256` (see the file comment). */
export function isSameCapture(captured: CancelIntentV1, observed: CancelIntentV1 | null, recordSha256: string): boolean {
  return observed !== null && observed.recordSha256 === recordSha256 && isDeepStrictEqual(observed, captured);
}

/** Whether `record` is the intent's ORIGINAL indexed record (as a parsed record; the caller has matched its exact bytes). */
export function isOwnOriginal(record: ScaleRecord, intent: DowngradeIntentV1): boolean {
  return record.version !== 1 && record.revision === intent.originalRevision && record.active.architecture === "local-indexed" && record.pending?.kind !== "downgrade";
}

/** Whether `record` is exactly this plan's fence. */
export function isOwnFence(record: ScaleRecord, plan: DowngradePlanV1, intent: DowngradeIntentV1): boolean {
  const pending = record.pending;
  return record.version !== 1 && record.revision === intent.fenceRevision && record.active.architecture === "local-indexed"
    && pending?.kind === "downgrade" && pending.plan === plan.digest && pending.revision === intent.fenceRevision && pending.target === plan.inventory.target
    && isDeepStrictEqual(record.requested, plan.inventory.requested);
}

/** Whether `record` has exactly the content of this plan's expected cancel record (the caller has matched its exact bytes). */
export function isExpectedCancelRecord(record: ScaleRecord, plan: DowngradePlanV1, intent: DowngradeIntentV1): boolean {
  return record.version !== 1 && record.revision === intent.fenceRevision + 1 && record.pending === null && record.active.architecture === "local-indexed"
    && isDeepStrictEqual(record.requested, plan.inventory.requested);
}
