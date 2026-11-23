/**
 * @file src/scale/gate.ts
 * @description The readiness decision every dependent mutation consults.
 *
 * An ordinary mutation waits for any transition or unresolved scale-down.
 * Missing, untrusted authority evidence is handled before a legacy fallback:
 *
 * - `scale-transition-pending`: a local transition is unfinished or parked;
 *   `llmwiki scale prepare` resumes it.
 * - `scale-backend-unavailable`: the recorded estimate needs a backend this
 *   build does not provide; lowering the estimate (`llmwiki scale set`)
 *   unblocks.
 * - `scale-state-unreadable`: the record cannot be trusted; restore the named
 *   file by hand. There is deliberately no automatic reset or force-delete.
 * - `scale-downgrade-pending`: an explicit scale-down is in progress; only
 *   resuming it (`llmwiki scale downgrade --apply`, same plan) settles it.
 * - `scale-profile-ineligible`: a `local-indexed` project refuses to activate
 *   a non-default profile, and its indexed listings refuse to serve one.
 *
 * The authoritative check runs inside the project mutation lock (the gate leg
 * in `operation-bundles/lock-gate.ts`, and the opted-in lock-free writers in
 * `operation-bundles/registered-project-lock.ts`). {@link assertScaleReady} is
 * the early, non-authoritative refusal callers run before a fetch or provider
 * call, so already-blocked work fails before it costs anything.
 *
 * The scale transition itself skips that ordinary leg (it must be able to
 * resume a pending or unavailable transition), so it checks its AUTHORITY
 * instead ({@link assertScaleAuthorityForUpdate}): under the raw lock before
 * any recovery leg, and in the transition preview.
 *
 * ONE OBSERVATION. {@link observeScaleRecord} is the single confined record
 * read; {@link scaleGateRefusalFrom} decides from it, so disk `scale status`
 * and the preview report exactly the admission the gate observed. A downgrade
 * proof may re-open the record leaf to check its identity, never to choose a
 * second record.
 */

import { realpath } from "node:fs/promises";
import { ScaleRefusalError } from "./contracts.js";
import { downgradeNeedsRecovery } from "./downgrade-admission.js";
import { restoreRefusal } from "../segments/restore-marker.js";
import { readScaleRecord, hasScaleRecord, indexedStoresMayExist, type ScaleRecordRead } from "./record.js";

/** Why dependent work must wait. */
export type ScaleGateBlock = "scale-transition-pending" | "scale-backend-unavailable" | "scale-state-unreadable" | "scale-profile-ineligible" | "scale-restore-in-progress" | "scale-downgrade-pending";

/** The operator remedy for each block. */
const REMEDY: Readonly<Record<ScaleGateBlock, string>> = Object.freeze({
  "scale-transition-pending": "a scale transition is unfinished; run `llmwiki scale prepare` to resume it, or `llmwiki scale status`",
  "scale-backend-unavailable": "the expected scale needs a backend this build does not provide; lower it with `llmwiki scale set`, or see `llmwiki scale status`",
  "scale-state-unreadable": "the scale record .llmwiki/scale.json cannot be read; restore that file by hand (see `llmwiki scale status`)",
  "scale-profile-ineligible": "a local-indexed project serves a custom profile only through its typed entity catalog (a loadable profile and the typed-entity-catalog-1 capability), and its profile cannot change while it is indexed (see `llmwiki scale status`)",
  "scale-restore-in-progress": "an indexed-authority restore holds .llmwiki/indexed-restore.json; wait for it, or re-run the same `llmwiki catalog restore` to finish an interrupted one",
  "scale-downgrade-pending": "an explicit scale-down is in progress; resume it with `llmwiki scale downgrade --apply` and the same plan, or, if it has moved nothing yet, cancel it with `llmwiki scale downgrade --cancel` and the same plan (see `llmwiki scale status`)",
});

/** Typed refusal of a mutation while the project is not ready. Nothing was written. */
export class ScaleGateError extends Error {
  constructor(readonly block: ScaleGateBlock, readonly reason?: string) {
    super(`${block}: ${REMEDY[block]}${reason === undefined ? "" : ` (${reason})`}`);
    this.name = "ScaleGateError";
  }
}

/** The block one record read implies, or `null` when ready. */
function scaleBlockOf(read: ScaleRecordRead): ScaleGateBlock | null {
  if (read.kind === "absent") return null;
  if (read.kind === "unreadable") return "scale-state-unreadable";
  const pending = read.record.pending;
  // A capability still `preparing` governs an authority that is not ready: ordinary mutations wait for its preparation.
  const preparing = read.record.version !== 1 && (read.record.capabilities ?? []).some((capability) => capability.status === "preparing");
  if (pending === null) return preparing ? "scale-transition-pending" : null;
  if (pending.kind === "downgrade") return "scale-downgrade-pending";
  return pending.kind === "unavailable" ? "scale-backend-unavailable" : "scale-transition-pending";
}

/** The refusal one record read implies, naming an unreadable record's fault, or `null` when ready. */
function scaleRefusalOf(read: ScaleRecordRead): ScaleGateError | null {
  const block = scaleBlockOf(read);
  if (block === null) return null;
  return new ScaleGateError(block, read.kind === "unreadable" ? read.reason : undefined);
}

/** Indexed stores without a record: fail closed (the incumbent files may be a stale backup). */
const MISSING_RECORD = "indexed stores exist but the scale record is missing; restore .llmwiki/scale.json by hand";

/** The one confined record read of the project at `root` (absent without a record leaf). Read-only. */
export async function observeScaleRecord(root: string): Promise<ScaleRecordRead> {
  return (await hasScaleRecord(root)) ? readScaleRecord(root) : { kind: "absent" };
}

/** The readiness refusal for the project at `root`, or `null` when ready. */
export async function scaleGateRefusal(root: string): Promise<ScaleGateError | null> {
  return scaleGateRefusalFrom(root, await observeScaleRecord(root));
}

/**
 * The readiness refusal `read` (one observation of `root`'s record) implies:
 * a foreign restore (a record present), then an unresolved downgrade, then
 * missing or unreadable authority, then the record's own readiness.
 */
export async function scaleGateRefusalFrom(root: string, read: ScaleRecordRead): Promise<ScaleGateError | null> {
  if (read.kind !== "absent") {
    const restoring = await restoreRefusal(await realpath(root).catch(() => root));
    if (restoring !== null) return new ScaleGateError("scale-restore-in-progress", restoring.message);
  }
  if (await downgradeNeedsRecovery(root, read)) return new ScaleGateError("scale-downgrade-pending");
  if (read.kind === "absent" && await indexedStoresMayExist(root)) return new ScaleGateError("scale-state-unreadable", MISSING_RECORD);
  return scaleRefusalOf(read);
}

/**
 * Refuse a scale update whose authority cannot be trusted, read-only: an
 * unreadable record, or a missing one while indexed stores may exist (the
 * incumbent files may be a stale backup), refuses `scale_state_unreadable`.
 * A lost record is never taken for a new project; a readable record (ready,
 * pending or unavailable) and a project with neither passes.
 */
export async function assertScaleAuthorityForUpdate(root: string, observed?: ScaleRecordRead): Promise<void> {
  const read = observed ?? await observeScaleRecord(root);
  if (read.kind === "unreadable") throw new ScaleRefusalError("scale_state_unreadable", `${read.reason}; restore it by hand`);
  if (read.kind === "absent" && await indexedStoresMayExist(root)) throw new ScaleRefusalError("scale_state_unreadable", MISSING_RECORD);
}

/** Refuse early when the project at `root` is already blocked. Not authoritative: the lock recheck is. */
export async function assertScaleReady(root: string): Promise<void> {
  const refusal = await scaleGateRefusal(root);
  if (refusal !== null) throw refusal;
}
