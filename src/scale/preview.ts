/**
 * @file src/scale/preview.ts
 * @description READ-ONLY PREVIEWS of a scale change. Nothing here takes the
 * project lock or writes a project file.
 *
 * TRANSITION PREVIEW ({@link previewScaleTransition}): what `scale set` with
 * this estimate would do, before it does it, computed by the SAME planning
 * body (`nextRecord`) over the same validated input and eligibility. The
 * current record and readiness; the `local-v2` plan; the record `set` would
 * write first; whether the active layout would change (`prepare`), prepare
 * new capabilities on an active indexed layout (`capability-upgrade`), stay
 * (`none`, including a smaller estimate that KEEPS a larger layout: lowering
 * an estimate is never a scale-down), or be recorded `unavailable`; the
 * steps `set` would then run; the conservative free-space
 * requirement against the free space measured now; the eligibility blocks
 * and capabilities an indexed layout needs; and the MEASURED size of the
 * project from its files (sources and generated wiki files, by one stat
 * each), so an estimate below reality is visible.
 *
 * SCALE-DOWN PREVIEW ({@link previewScaleDowngrade}): the plan of an explicit
 * scale-down (`./downgrade-inventory.ts`, `./downgrade-plan.ts`), with every
 * blocker, and the free-space blocker measured now (never bound in the plan).
 * Its exports read the indexed stores under this process's reader lease, so
 * the APPLY must then run in a fresh process (a collector may not have read
 * the stores itself).
 */

import { canonicalRoot } from "../segments/reader-lease.js";
import type { ScaleRequest } from "./contracts.js";
import type { CapabilityNameV3, IneligibleReason, ScalePlanV2, ScaleRecord } from "./contracts-v2.js";
import type { DowngradeBlockerV1, DowngradeMeasuredV1 } from "./downgrade-contracts.js";
import { measureContent } from "./downgrade-freeze.js";
import { checkedTarget, inventoryDowngrade, spaceBlocker, type DowngradeRequestV1 } from "./downgrade-inventory.js";
import { buildDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";
import { diskScaleCapabilities, diskScaleEligibility } from "./eligibility.js";
import { nextRecord, requireRequestedHeld } from "./next-record.js";
import { indexedPreflightRequiredBytes, planScaleV2 } from "./plan-v2.js";
import { preflightRequiredBytes } from "./plan.js";
import { diskPreflightIo, type PreflightIo } from "./steps.js";
import { assertNoDowngradeForScaleUpdate } from "./downgrade-admission.js";
import { assertScaleAuthorityForUpdate, observeScaleRecord } from "./gate.js";
import { checkedCapabilities, recordForUpdateFrom, scaleStatusObserved, type ScaleReport } from "./transition.js";

/** What `scale set` with an estimate would do. */
export interface ScaleTransitionPreviewV1 {
  readonly current: ScaleReport;
  readonly plan: ScalePlanV2;
  /** The record `scale set` would write first (from the same planning body), before any preparation. */
  readonly next: ScaleRecord;
  /**
   * `prepare`: a larger layout would be prepared; `capability-upgrade`: the active indexed layout would prepare
   * new capabilities; `none`: the active layout stays (it already serves the estimate); `unavailable`: recorded, blocking.
   */
  readonly change: "prepare" | "capability-upgrade" | "none" | "unavailable";
  readonly steps: readonly string[];
  /** The conservative free space a preparation requires, and what is free now (null when no layout would be prepared). */
  readonly preflight: { readonly requiredBytes: number; readonly freeBytes: number } | null;
  readonly eligibility: readonly IneligibleReason[];
  /** The capabilities the next record holds `preparing`. */
  readonly capabilities: readonly CapabilityNameV3[];
  readonly measured: DowngradeMeasuredV1;
  /** True when the measured size alone would plan a larger layout than the estimate does. */
  readonly estimateBelowMeasured: boolean;
}

/** What an explicit scale-down would do. */
export interface ScaleDowngradePreviewV1 {
  readonly plan: DowngradePlanV1;
  /** The free-space blocker measured now (never bound into the plan), or null. */
  readonly space: DowngradeBlockerV1 | null;
  /** True when the plan carries no blocker and the space suffices. */
  readonly ready: boolean;
}

/** Rank a planned architecture (unavailable highest). */
function rank(architecture: ScalePlanV2["architecture"]): number {
  return ["local-standard", "local-large", "local-indexed", "unavailable"].indexOf(architecture);
}

/** The names of `record`'s capabilities still preparing. */
function preparing(record: ScaleRecord): CapabilityNameV3[] {
  return record.version === 1 ? [] : (record.capabilities ?? []).filter((capability) => capability.status === "preparing").map((capability) => capability.name);
}

/**
 * The change `next` makes and the steps `scale set` would then run. With
 * nothing pending, `set` prepares EVERY capability still `preparing` (a new
 * one, or one an interrupted upgrade left preparing), then verifies.
 */
function changeOf(next: ScaleRecord): { change: ScaleTransitionPreviewV1["change"]; steps: string[] } {
  if (next.pending?.kind === "unavailable") return { change: "unavailable", steps: [] };
  if (next.pending?.kind === "prepare") return { change: "prepare", steps: next.pending.steps.map((step) => step.name) };
  const upgrading = preparing(next);
  return upgrading.length > 0 ? { change: "capability-upgrade", steps: [...upgrading, "activation-verify"] } : { change: "none", steps: [] };
}

/** The free-space requirement of preparing `plan`. */
function requiredBytesOf(plan: ScalePlanV2): number {
  return plan.architecture === "local-indexed" ? indexedPreflightRequiredBytes(plan.requested) : preflightRequiredBytes(plan.requested);
}

/**
 * Preview `scale set` with `request` (and extra `capabilities`) on the project
 * at `root`. Read-only. It refuses exactly as `scale set` would (an invalid
 * estimate or capability, an explicit capability the resulting layout
 * cannot hold, an unreadable record, a missing record beside indexed stores,
 * a scale-down in progress, checked downgrade first as `scale set` does) and
 * reports the record `scale set` would write first, from the same body. One
 * confined record observation serves the checks, the plan and `current`.
 */
export async function previewScaleTransition(root: string, request: ScaleRequest, capabilities: readonly CapabilityNameV3[] = [], space: PreflightIo = diskPreflightIo(root)): Promise<ScaleTransitionPreviewV1> {
  const plan = planScaleV2(request);
  const requested = checkedCapabilities(capabilities);
  const read = await observeScaleRecord(root);
  await assertNoDowngradeForScaleUpdate(root, read);
  await assertScaleAuthorityForUpdate(root, read);
  const record = recordForUpdateFrom(read);
  const eligibility = await diskScaleEligibility(root);
  const next = requireRequestedHeld(nextRecord(record, plan, eligibility, [...new Set([...await diskScaleCapabilities(root), ...requested])]), requested);
  const { change, steps } = changeOf(next);
  const measured = await measureContent(root);
  const actual = planScaleV2({ documents: Math.max(1, measured.sourceDocuments), sizeBytes: Math.max(1, measured.sourceBytes) });
  return {
    current: await scaleStatusObserved(root, read), plan, next, change, steps, measured, estimateBelowMeasured: rank(actual.architecture) > rank(plan.architecture),
    preflight: change === "prepare" ? { requiredBytes: requiredBytesOf(plan), freeBytes: await space.freeBytes() } : null,
    eligibility: next.pending?.kind === "unavailable" && next.pending.exceeds.length === 0 ? eligibility : [], capabilities: preparing(next),
  };
}

/** Preview an explicit scale-down of the project at `root`. Read-only. */
export async function previewScaleDowngrade(root: string, input: DowngradeRequestV1, space?: PreflightIo): Promise<ScaleDowngradePreviewV1> {
  checkedTarget(input.target);
  planScaleV2(input.request);
  const canonical = await canonicalRoot(root);
  const plan = buildDowngradePlan(canonical, await inventoryDowngrade(canonical, input));
  const blocker = await spaceBlocker(plan.inventory, space ?? diskPreflightIo(canonical));
  return { plan, space: blocker, ready: plan.inventory.blockers.length === 0 && blocker === null };
}
