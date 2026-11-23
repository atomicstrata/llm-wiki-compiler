/**
 * @file src/sdk/scale-facade.ts
 * @description The SDK surface of a project's expected scale: `wiki.scale`
 * (status, set, prepare) and the async creation entry behind `initWiki`.
 *
 * It is the same code the CLI runs. An expected scale is a planning target,
 * not verified capacity, and both architectures it prepares are local only.
 * Invalid input, a revision conflict and an unreadable record throw the typed
 * {@link ScaleRefusalError} with nothing changed; a valid estimate this build
 * cannot serve is RECORDED and reported `unavailable`, and blocks dependent
 * work until it is lowered. `createWiki` stays synchronous and does no I/O;
 * creation with an estimate is the async {@link initProjectAtRoot}.
 */

import { ScaleRefusalError, type ScaleRequest } from "../scale/contracts.js";
import { initProject, type InitProjectResult } from "../scale/init.js";
import type { CapabilityNameV3 } from "../scale/contracts-v2.js";
import { prepareExpectedScale, scaleStatus, setExpectedScale, type ScaleReport } from "../scale/transition.js";
import type { ReportPageV1 } from "../compiler/batch/report.js";
import { applyScaleDowngrade, type DowngradeApplyResultV1 } from "../scale/downgrade-apply.js";
import { cancelScaleDowngrade, type DowngradeCancelResultV1 } from "../scale/downgrade-cancel.js";
import { listScaleArchives, readArchivedReport, type ScaleArchiveV1 } from "../scale/downgrade-archive-reader.js";
import type { DowngradeTarget } from "../scale/contracts-v2.js";
import { parseDowngradePlan, type DowngradePlanV1 } from "../scale/downgrade-plan.js";
import { previewScaleDowngrade, previewScaleTransition, type ScaleDowngradePreviewV1, type ScaleTransitionPreviewV1 } from "../scale/preview.js";
import { canonicalRoot } from "../segments/reader-lease.js";

export type { ScaleReport, ScaleReadiness } from "../scale/transition.js";
export type { ScaleRecordV1, ScaleRequest, ScalePlan, ScaleRefusalCode } from "../scale/contracts.js";
export type { ScaleRecord, ScaleRecordV2, ScalePlanV2, LocalArchitectureV2, IneligibleReason, MissingBackendV2, CapabilityNameV3 } from "../scale/contracts-v2.js";
export type { InitProjectResult } from "../scale/init.js";
export type { ScaleTransitionPreviewV1, ScaleDowngradePreviewV1 } from "../scale/preview.js";
export type { DowngradeApplyResultV1 } from "../scale/downgrade-apply.js";
export type { DowngradeCancelResultV1 } from "../scale/downgrade-cancel.js";
export type { DowngradePlanV1 } from "../scale/downgrade-plan.js";
export type { ScaleArchiveV1 } from "../scale/downgrade-archive-reader.js";
export type { ScaleDowngradeCode, DowngradeBlockerV1, DowngradeNoticeCode } from "../scale/downgrade-contracts.js";

/** Input of `wiki.scale.set`. */
export interface SdkScaleSetInput {
  /** Expected total source bytes: a positive safe integer; derived from documents when omitted. */
  sizeBytes?: number;
  /** Expected document count: a positive safe integer; derived from bytes when omitted. At least one is required. */
  documents?: number;
  /** Prepare now (default) or leave the transition pending, blocking dependent work. */
  prepare?: boolean;
  /** Refuse unless the current record revision is exactly this (0 for none). */
  expectedRevision?: number;
  /** Version 3 capabilities of a `local-indexed` layout to hold and prepare (`segmented-compile-state-1`). */
  capabilities?: CapabilityNameV3[];
}

/** Input of `wiki.scale.prepare`. */
export interface SdkScalePrepareInput {
  /** Version 3 capabilities to hold; on an active indexed project they are prepared as an upgrade. */
  capabilities?: CapabilityNameV3[];
}

/** Input of `wiki.scale.downgrade.preview`. */
export interface SdkScaleDowngradeInput {
  /** The smaller layout: `local-standard` or `local-large`. */
  target: DowngradeTarget;
  /** The new expected scale (at least one figure); it must plan no larger than the target. */
  sizeBytes?: number;
  documents?: number;
}

/**
 * `wiki.scale.downgrade`: an explicit scale-down. `preview` is read-only (its
 * exports read the indexed stores under this process's reader lease); `apply`
 * must then run in a FRESH process (a collector may not have read the stores
 * itself), with the operator's `readersOffline` assertion. `cancel` returns
 * a scale-down that has moved nothing yet to the incumbent layout (it
 * refuses after the first move; its result says whether the planned estimate
 * stayed on the record or no record was written). A plan may
 * be given as the preview's object or its saved text.
 */
export interface WikiScaleDowngradeSurface {
  preview(input: SdkScaleDowngradeInput): Promise<ScaleDowngradePreviewV1>;
  apply(plan: DowngradePlanV1 | string, options: { readersOffline: boolean }): Promise<DowngradeApplyResultV1>;
  cancel(plan: DowngradePlanV1 | string, options: { readersOffline: boolean }): Promise<DowngradeCancelResultV1>;
}

/** `wiki.scale.archives`: the archives scale-downs retained, read-only. */
export interface WikiScaleArchivesSurface {
  list(): Promise<ScaleArchiveV1[]>;
  /** One page of an archived batch run's report; continue with the page's cursor. */
  report(name: string, runId: string, options?: { cursor?: string }): Promise<ReportPageV1>;
}

/** `wiki.scale`: the expected scale of this project. */
export interface WikiScaleSurface {
  /** Read-only, lock-free report: request, plan, active architecture, readiness, blocked reason. */
  status(): Promise<ScaleReport>;
  /** Record a new estimate and (by default) prepare the local architecture it plans for. */
  set(input: SdkScaleSetInput): Promise<ScaleReport>;
  /** Resume or re-verify a pending transition, or upgrade an active indexed project's capabilities; an unavailable estimate is reported, not prepared. */
  prepare(input?: SdkScalePrepareInput): Promise<ScaleReport>;
  /** What `set` with this estimate would do, read-only: a smaller estimate never scales down. */
  preview(input: { sizeBytes?: number; documents?: number; capabilities?: CapabilityNameV3[] }): Promise<ScaleTransitionPreviewV1>;
  readonly downgrade: WikiScaleDowngradeSurface;
  readonly archives: WikiScaleArchivesSurface;
}

/** Allowlist-construct the request so no extra caller property rides along. */
function requestOf(input: SdkScaleSetInput): ScaleRequest {
  if (input === null || typeof input !== "object") throw new ScaleRefusalError("scale_invalid_request", "set requires an object");
  return {
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
    ...(input.documents === undefined ? {} : { documents: input.documents }),
  };
}

/** The plan to apply: the object (re-validated strictly from its text) or saved text, for canonical `root`. */
async function planFor(root: string, plan: DowngradePlanV1 | string): Promise<DowngradePlanV1> {
  const canonical = await canonicalRoot(root);
  return parseDowngradePlan(typeof plan === "string" ? plan : JSON.stringify(plan), canonical);
}

/** `wiki.scale.downgrade` and `wiki.scale.archives` for the project at `root`. */
function buildChangeFacade(root: string, run: <T>(fn: () => Promise<T>) => Promise<T>): Pick<WikiScaleSurface, "downgrade" | "archives"> {
  return {
    downgrade: {
      preview: (input) => run(() => previewScaleDowngrade(root, { target: input?.target, request: requestOf(input) })),
      apply: (plan, options) => run(async () => applyScaleDowngrade(await canonicalRoot(root), await planFor(root, plan), { readersOffline: options?.readersOffline === true })),
      cancel: (plan, options) => run(async () => cancelScaleDowngrade(await canonicalRoot(root), await planFor(root, plan), { readersOffline: options?.readersOffline === true })),
    },
    archives: {
      list: () => run(() => listScaleArchives(root)),
      report: (name, runId, options) => run(() => readArchivedReport(root, name, runId, options?.cursor)),
    },
  };
}

/** Build `wiki.scale` for the project at `root`, each call run through `run` (the SDK's quiet wrapper). */
export function buildScaleFacade(root: string, run: <T>(fn: () => Promise<T>) => Promise<T>): WikiScaleSurface {
  return {
    status: () => run(() => scaleStatus(root)),
    set: (input) => run(() => setExpectedScale(root, {
      request: requestOf(input), prepare: input?.prepare !== false, expectedRevision: input?.expectedRevision,
      ...(input?.capabilities === undefined ? {} : { capabilities: [...input.capabilities] }),
    })),
    prepare: (input) => run(() => prepareExpectedScale(root, input?.capabilities === undefined ? {} : { capabilities: [...input.capabilities] })),
    preview: (input) => run(() => previewScaleTransition(root, requestOf(input), input?.capabilities ?? [])),
    ...buildChangeFacade(root, run),
  };
}

/** Create (or re-verify) the project at an already-normalized `root`, then set `expected` when given. */
export function initProjectAtRoot(root: string, expected?: ScaleRequest): Promise<InitProjectResult> {
  return initProject(root, expected);
}
