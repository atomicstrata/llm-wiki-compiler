/**
 * @file src/scale/plan-v2.ts
 * @description Pure planning under the version 2 policy `local-v2`.
 *
 * The version 1 planner decides `local-standard` and `local-large` exactly as
 * before; version 2 only reconsiders what version 1 calls `unavailable`,
 * offering `local-indexed` up to the provisional indexed bound and
 * `unavailable` beyond it. Nothing here reads or writes disk.
 */

import type { RequestedScaleV1, ScaleRequest, EnvelopeBound } from "./contracts.js";
import {
  INDEXED_MAX_BYTES, INDEXED_MAX_DOCUMENTS, type LocalArchitectureV2, type PlannedArchitectureV2, type ScalePlanV2,
} from "./contracts-v2.js";
import { planRecorded, planScale, preflightRequiredBytes } from "./plan.js";
import type { ScalePlan } from "./contracts.js";

/** Conservative per-document allowance for the catalog, history segments and their retained merges. */
const INDEXED_BYTES_PER_DOCUMENT = 256 * 1024;

/** Which indexed-envelope bounds a recorded estimate exceeds. */
function indexedExceeds(requested: RequestedScaleV1): EnvelopeBound[] {
  const exceeds: EnvelopeBound[] = [];
  if (requested.documents > INDEXED_MAX_DOCUMENTS) exceeds.push("documents");
  if (requested.sizeBytes > INDEXED_MAX_BYTES) exceeds.push("bytes");
  return exceeds;
}

/** Re-decide a version 1 plan under `local-v2`. */
function upgrade(plan: ScalePlan): ScalePlanV2 {
  if (plan.architecture !== "unavailable") return plan;
  const exceeds = indexedExceeds(plan.requested);
  return exceeds.length === 0
    ? { requested: plan.requested, architecture: "local-indexed", exceeds: [] }
    : { requested: plan.requested, architecture: "unavailable", exceeds };
}

/** Plan one estimate under `local-v2`. Invalid input refuses exactly as version 1 does. */
export function planScaleV2(request: ScaleRequest): ScalePlanV2 {
  return upgrade(planScale(request));
}

/** Re-plan a RECORDED estimate under `local-v2`, on its recorded basis. */
export function planRecordedV2(requested: RequestedScaleV1): ScalePlanV2 {
  return upgrade(planRecorded(requested));
}

/** Rank local architectures so a larger one is a compatible superset of a smaller one. */
function rank(architecture: LocalArchitectureV2): number {
  return architecture === "local-indexed" ? 2 : architecture === "local-large" ? 1 : 0;
}

/** Whether `planned` needs a transition from `active`; a smaller or equal plan never does. */
export function needsTransitionV2(active: LocalArchitectureV2, planned: PlannedArchitectureV2): planned is "local-large" | "local-indexed" {
  return planned !== "unavailable" && planned !== "local-standard" && rank(active) < rank(planned);
}

/**
 * The conservative free-space requirement for a `local-indexed` preparation:
 * the version 1 estimate (sources, generated pages, embeddings twice, fixed
 * headroom) plus an allowance per document for the indexed stores and the
 * merge outputs this build retains rather than deletes.
 */
export function indexedPreflightRequiredBytes(requested: RequestedScaleV1): number {
  const total = preflightRequiredBytes(requested) + requested.documents * INDEXED_BYTES_PER_DOCUMENT;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}
