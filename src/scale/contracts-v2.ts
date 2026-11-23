/**
 * @file src/scale/contracts-v2.ts
 * @description Version 2 of the expected-scale record and its planning
 * policy `local-v2`, BESIDE version 1, which is unchanged.
 *
 * Version 2 adds one architecture, `local-indexed`: the same machine and
 * files, with a durable paged catalog, segmented history (events, relations,
 * workspace operation catalogs) and piecewise vector storage, all under
 * `.llmwiki/indexed/`. `local-standard` and `local-large` keep EXACTLY their
 * version 1 thresholds, so any estimate version 1 can express plans the same
 * under both, and such records are still written as version 1 for older
 * lifecycle builds. Only a record that needs `local-indexed`, or the new
 * policy's unavailable outcome, is written as version 2; an older lifecycle
 * build then fails closed on it, which is correct, because it could not keep
 * the indexed stores current.
 *
 * THE INDEXED BOUND IS PROVISIONAL AND EVIDENCE-SPECIFIC: it is set no higher
 * than the largest synthetic corpus this build was measured at on actual disk.
 * It is a planning policy, not a capacity qualification, and it does not make
 * compile, index regeneration, exports or snapshots sublinear: those remain
 * global work and are why `out-of-core-compilation` is still missing beyond it.
 */

import {
  AVERAGE_DOCUMENT_BYTES, type EnvelopeBound, type RequestedScaleV1, type ScaleRecordV1, type StepStatus,
} from "./contracts.js";

/** The only version 2 policy this build knows. */
export const SCALE_POLICY_V2 = "local-v2";

/** Planning policy: at most this many documents plan `local-indexed` (provisional; see the file comment). */
export const INDEXED_MAX_DOCUMENTS = 10_000;
/** Planning policy: source bytes for `local-indexed`, the same documents at the average size (625 MiB). */
export const INDEXED_MAX_BYTES = INDEXED_MAX_DOCUMENTS * AVERAGE_DOCUMENT_BYTES;

/** An architecture this build can make active under version 2. All are local. */
export type LocalArchitectureV2 = "local-standard" | "local-large" | "local-indexed";

/** What an estimate plans under `local-v2`. */
export type PlannedArchitectureV2 = LocalArchitectureV2 | "unavailable";

/** Backends an estimate beyond the indexed envelope would need. */
export const MISSING_BACKENDS_V2 = Object.freeze(["out-of-core-compilation", "durable-hosted-backend"] as const);

/** A backend version 2 does not provide. */
export type MissingBackendV2 = (typeof MISSING_BACKENDS_V2)[number];

/**
 * Project facts that make `local-indexed` unavailable whatever the estimate:
 * a non-default profile (its entity pages are not catalogued) and a project
 * registered for portable publication (its receipts and labels are never
 * routed through derived stores).
 */
export const INELIGIBLE_REASONS = Object.freeze(["profile-entity-catalog", "registered-portable-indexed-publication"] as const);

/** One eligibility block. */
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

/** The ordered steps of a `local-indexed` preparation; activation is a separate, final write. */
export const INDEXED_STEPS = Object.freeze([
  "capacity-preflight", "catalog-build", "history-import", "vector-shards", "activation-verify",
] as const);

/** The ordered steps of a version 2 `local-large` preparation (the version 1 steps). */
export const LARGE_STEPS_V2 = Object.freeze(["capacity-preflight", "embedding-container"] as const);

/** One step name of either target. */
export type StepNameV2 = (typeof INDEXED_STEPS)[number] | (typeof LARGE_STEPS_V2)[number];

/** One step's persisted progress. */
export interface StepRecordV2 {
  readonly name: StepNameV2;
  readonly status: StepStatus;
  readonly detail?: string;
}

/** The architecture currently serving the project. */
export interface ActiveArchitectureV2 {
  readonly architecture: LocalArchitectureV2;
  readonly sinceRevision: number;
}

/** An unfinished transition toward a larger local architecture. */
export interface PreparePendingV2 {
  readonly kind: "prepare";
  readonly revision: number;
  readonly target: "local-large" | "local-indexed";
  readonly steps: readonly StepRecordV2[];
}

/**
 * A recorded estimate this build cannot serve. Either the estimate exceeds the
 * indexed envelope (`exceeds` non-empty, `missing` = every backend of
 * {@link MISSING_BACKENDS_V2}) or it plans `local-indexed` on an ineligible
 * project (`exceeds` empty, `missing` = the eligibility blocks).
 */
export interface UnavailablePendingV2 {
  readonly kind: "unavailable";
  readonly revision: number;
  readonly exceeds: readonly EnvelopeBound[];
  readonly missing: ReadonlyArray<MissingBackendV2 | IneligibleReason>;
}

/** A layout an explicit scale-down may target: one smaller than `local-indexed`. */
export type DowngradeTarget = "local-standard" | "local-large";

/**
 * An explicit scale-down of an ACTIVE `local-indexed` project in progress. It
 * is written BEFORE any effect of the scale-down and is the fence for every
 * build: earlier builds' strict parsers do not know this kind, so they read
 * the record as unreadable and refuse; this build's gate refuses dependent
 * work. `active` stays `local-indexed` until the final activation write.
 */
export interface DowngradePendingV2 {
  readonly kind: "downgrade";
  readonly revision: number;
  readonly target: DowngradeTarget;
  /** The SHA-256 digest of the plan being applied; only that plan may resume it. */
  readonly plan: string;
}

/**
 * The capabilities a VERSION 3 record carries: opt-in authorities that older
 * builds must not touch. A version 3 record is a version 2 record plus a
 * non-empty `capabilities` list; older builds cannot parse version 3, so they
 * refuse every routed effect (`scale-state-unreadable`) BEFORE the first
 * incompatible effect. A capability is `preparing` from the record that first
 * names it (before any effect it governs) and `ready` from the activation
 * that verified it.
 */
export const CAPABILITIES_V3 = Object.freeze(["typed-entity-catalog-1", "segmented-compile-state-1"] as const);

/** One capability name. */
export type CapabilityNameV3 = (typeof CAPABILITIES_V3)[number];

/** One capability and its status. */
export interface CapabilityV3 {
  readonly name: CapabilityNameV3;
  readonly status: "preparing" | "ready";
}

/** The persisted version 2 record; version 3 when it carries capabilities. */
export interface ScaleRecordV2 {
  readonly version: 2 | 3;
  readonly policy: typeof SCALE_POLICY_V2;
  readonly revision: number;
  readonly requested: RequestedScaleV1;
  readonly active: ActiveArchitectureV2;
  readonly pending: PreparePendingV2 | UnavailablePendingV2 | DowngradePendingV2 | null;
  /** Present (non-empty) exactly on a version 3 record. */
  readonly capabilities?: readonly CapabilityV3[];
}

/** The plan for one estimate under `local-v2`. */
export interface ScalePlanV2 {
  readonly requested: RequestedScaleV1;
  readonly architecture: PlannedArchitectureV2;
  readonly exceeds: readonly EnvelopeBound[];
}

/** Any record this build reads: version 1 under its frozen policy, or version 2. */
export type ScaleRecord = ScaleRecordV1 | ScaleRecordV2;
