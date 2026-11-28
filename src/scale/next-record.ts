/**
 * @file src/scale/next-record.ts
 * @description The one next record for a plan, and the version it is
 * written in.
 *
 * Planning always uses the current policy `local-v2`. The resulting record is
 * written as VERSION 1 whenever version 1 can express it: the active and the
 * planned architectures are both `local-standard` or `local-large`, whose
 * thresholds are identical under both policies, so the bytes are exactly what
 * the previous lifecycle build writes and that build keeps working. Anything
 * involving `local-indexed`, or the new policy's unavailable outcome, is
 * written as version 2.
 *
 * A larger active architecture is never downgraded: a smaller estimate keeps
 * it (and its prepared stores) and is ready at once. An estimate that plans
 * `local-indexed` on an ineligible project is recorded unavailable with the
 * eligibility blocks, before any preparation effect.
 *
 * CAPABILITIES (version 3). A capability the project needs (a custom profile
 * needs `typed-entity-catalog-1`) is written `preparing` in the SAME record
 * that first plans the indexed preparation, before any preparation effect, so
 * an older build refuses from then on. Held capabilities are carried by every
 * later record while the project is or is becoming indexed.
 *
 * EXPLICIT REQUESTS ({@link requireRequestedHeld}). A capability the operator
 * names explicitly must be HELD by the record a command would actually store
 * or act on, or the command refuses before any write or preparation step.
 * Naming one never promotes the planned layout, and is never silently
 * dropped: only an active `local-indexed` layout, or a real eligible pending
 * preparation of one, holds capabilities. Implicit profile needs are planned
 * as before and are not checked here.
 */

import {
  MISSING_BACKENDS_V2, type CapabilityNameV3, type CapabilityV3, type IneligibleReason, type ScalePlanV2, type ScaleRecord, type ScaleRecordV2,
} from "./contracts-v2.js";
import { PREPARATION_STEPS, ScaleRefusalError, type ScalePlan, type ScaleRecordV1 } from "./contracts.js";
import { needsTransitionV2, planRecordedV2 } from "./plan-v2.js";
import { stepsFor } from "./record-v2-schema.js";

/** Whether version 1 can express a record with this active and planned architecture. */
function expressibleInV1(active: string, planned: string): boolean {
  const v1 = ["local-standard", "local-large"];
  return v1.includes(active) && v1.includes(planned);
}

/** The version 1 record for a plan version 1 can express. */
function nextV1(revision: number, plan: ScalePlanV2, active: ScaleRecordV1["active"]): ScaleRecordV1 {
  const base = { version: 1 as const, revision, requested: plan.requested, active };
  if (!needsTransitionV2(active.architecture, plan.architecture)) return { ...base, pending: null };
  const steps = PREPARATION_STEPS.map((name) => ({ name, status: "pending" as const }));
  return { ...base, pending: { kind: "prepare", revision, target: "local-large", steps } };
}

/** The pending part of a version 2 record. */
function pendingV2(revision: number, plan: ScalePlanV2, active: ScaleRecordV2["active"], ineligible: readonly IneligibleReason[]): ScaleRecordV2["pending"] {
  if (plan.architecture === "unavailable") return { kind: "unavailable", revision, exceeds: plan.exceeds, missing: [...MISSING_BACKENDS_V2] };
  if (!needsTransitionV2(active.architecture, plan.architecture)) return null;
  if (plan.architecture === "local-indexed" && ineligible.length > 0) return { kind: "unavailable", revision, exceeds: [], missing: [...ineligible] };
  const steps = stepsFor(plan.architecture).map((name) => ({ name, status: "pending" as const }));
  return { kind: "prepare", revision, target: plan.architecture, steps };
}

/**
 * The single next revision for `plan` (re-planned under `local-v2` from its
 * recorded estimate), preserving the active architecture. `ineligible` lists
 * the eligibility blocks of the project, checked by the caller under the lock.
 */
export function nextRecord(
  current: ScaleRecord | null, plan: ScalePlan | ScalePlanV2, ineligible: readonly IneligibleReason[] = [], wanted: readonly CapabilityNameV3[] = [],
): ScaleRecord {
  const revision = (current?.revision ?? 0) + 1;
  const active = current?.active ?? { architecture: "local-standard" as const, sinceRevision: revision };
  const planned = planRecordedV2(plan.requested);
  if (expressibleInV1(active.architecture, planned.architecture)) return nextV1(revision, planned, active as ScaleRecordV1["active"]);
  const pending = pendingV2(revision, planned, active, ineligible);
  const capabilities = nextCapabilities(current, wanted, active.architecture === "local-indexed" || (pending?.kind === "prepare" && pending.target === "local-indexed"));
  return {
    version: capabilities.length > 0 ? 3 : 2, policy: "local-v2", revision, requested: planned.requested, active, pending,
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };
}

/**
 * `record` (the one a command would store or act on; null when there is none)
 * once it holds every explicitly `requested` capability, preparing or ready;
 * otherwise refuse `scale_invalid_request` naming the first missing one. Pure.
 */
export function requireRequestedHeld<T extends ScaleRecord | null>(record: T, requested: readonly CapabilityNameV3[]): T {
  const held = record === null || record.version === 1 ? [] : (record.capabilities ?? []).map((capability) => capability.name);
  const missing = requested.find((name) => !held.includes(name));
  if (missing !== undefined) {
    throw new ScaleRefusalError("scale_invalid_request", `capability ${missing} requires an active or eligible pending local-indexed layout; requesting it does not change the layout`);
  }
  return record;
}

/**
 * The capabilities of the next record: every current one is PRESERVED (never
 * silently dropped or downgraded) while the project is or is becoming
 * indexed, and each `wanted` one not yet held is added as `preparing`. A
 * project that is neither indexed nor preparing to be holds none: a
 * `preparing` capability whose preparation was re-planned away governed no
 * active authority.
 */
function nextCapabilities(current: ScaleRecord | null, wanted: readonly CapabilityNameV3[], indexed: boolean): CapabilityV3[] {
  if (!indexed) return [];
  const held = current !== null && current.version !== 1 ? [...(current.capabilities ?? [])] : [];
  for (const name of wanted) if (!held.some((capability) => capability.name === name)) held.push({ name, status: "preparing" });
  return held;
}
