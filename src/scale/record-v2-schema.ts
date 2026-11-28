/**
 * @file src/scale/record-v2-schema.ts
 * @description The STRICT, CLOSED schema of a version 2 scale record, and the
 * version dispatch every reader and writer goes through.
 *
 * Version 1 records are parsed by the frozen version 1 parser under the
 * version 1 policy, unchanged: an old unavailable estimate stays readable and
 * blocking. Version 2 records are checked field by field like version 1, then
 * for COHERENCE with the `local-v2` policy: the recorded estimate must
 * re-derive exactly; an estimate beyond the indexed envelope must be recorded
 * unavailable with exactly the exceeded bounds and every missing backend; an
 * eligibility block is allowed only for an estimate that plans
 * `local-indexed` on a project not already indexed; otherwise a prepare
 * transition, targeting exactly the plan with exactly its steps, is present
 * precisely when the plan is larger than the active architecture. Version 3
 * is version 2 plus a closed, non-empty `capabilities` list (known names, no
 * duplicates, `preparing` or `ready`), held only by a project that is or is
 * becoming `local-indexed`. Any other version is unreadable. Nothing is
 * repaired or defaulted.
 *
 * A `downgrade` pending (an explicit scale-down in progress) belongs only to
 * an ACTIVE `local-indexed` project, targets a smaller local layout, names the
 * SHA-256 of its plan, and requires the recorded estimate to plan no larger
 * than its target. Builds that predate the kind reject it as unreadable,
 * which is exactly the fence the scale-down relies on.
 */

import { isDeepStrictEqual } from "node:util";
import { MAX_STEP_DETAIL_CHARS, type ScaleRecordV1 } from "./contracts.js";
import {
  CAPABILITIES_V3, INDEXED_STEPS, INELIGIBLE_REASONS, LARGE_STEPS_V2, MISSING_BACKENDS_V2, SCALE_POLICY_V2,
  type ActiveArchitectureV2, type CapabilityV3, type DowngradePendingV2, type PreparePendingV2, type ScalePlanV2, type ScaleRecord, type ScaleRecordV2,
  type StepRecordV2, type UnavailablePendingV2,
} from "./contracts-v2.js";
import { needsTransitionV2, planRecordedV2 } from "./plan-v2.js";
import {
  count, exactObject, oneOf, orderedSubset, parseScaleRecord, reject, requested, serializeScaleRecord, type Fields,
} from "./record-schema.js";

/** The steps a target's preparation lists, in order. */
export function stepsFor(target: PreparePendingV2["target"]): readonly StepRecordV2["name"][] {
  return target === "local-indexed" ? INDEXED_STEPS : LARGE_STEPS_V2;
}

/** The active architecture; never later than the record's revision. */
function active(value: unknown, revision: number): ActiveArchitectureV2 {
  const fields = exactObject(value, "active", ["architecture", "sinceRevision"]);
  const sinceRevision = count(fields.sinceRevision, "active.sinceRevision");
  if (sinceRevision > revision) reject("active.sinceRevision is later than the record revision");
  return { architecture: oneOf(fields.architecture, "active.architecture", ["local-standard", "local-large", "local-indexed"] as const), sinceRevision };
}

/** One step at its fixed position for `names`. */
function step(value: unknown, at: number, names: readonly StepRecordV2["name"][]): StepRecordV2 {
  const fields = exactObject(value, "step", ["name", "status"], ["detail"]);
  if (fields.name !== names[at]) reject("steps must list the target's steps in order");
  const status = oneOf(fields.status, "step.status", ["pending", "done", "parked"] as const);
  if (fields.detail === undefined) return { name: names[at]!, status };
  if (typeof fields.detail !== "string" || fields.detail.length > MAX_STEP_DETAIL_CHARS) reject("step.detail must be a bounded string");
  return { name: names[at]!, status, detail: fields.detail };
}

/** A prepare transition. */
function preparePending(fields: Fields): PreparePendingV2 {
  exactObject(fields, "pending", ["kind", "revision", "target", "steps"]);
  const target = oneOf(fields.target, "pending.target", ["local-large", "local-indexed"] as const);
  const names = stepsFor(target);
  if (!Array.isArray(fields.steps) || fields.steps.length !== names.length) reject("pending.steps must list every step of the target");
  return { kind: "prepare", revision: fields.revision as number, target, steps: fields.steps.map((value, at) => step(value, at, names)) };
}

/** A recorded unavailable estimate; `exceeds` may be empty only for an eligibility block. */
function unavailablePending(fields: Fields): UnavailablePendingV2 {
  exactObject(fields, "pending", ["kind", "revision", "exceeds", "missing"]);
  const exceeds = Array.isArray(fields.exceeds) && fields.exceeds.length === 0 ? [] : orderedSubset(fields.exceeds, "pending.exceeds", ["documents", "bytes"] as const);
  const allowed = exceeds.length === 0 ? INELIGIBLE_REASONS : MISSING_BACKENDS_V2;
  return { kind: "unavailable", revision: fields.revision as number, exceeds, missing: orderedSubset<string>(fields.missing, "pending.missing", allowed) as UnavailablePendingV2["missing"] };
}

/** An explicit scale-down in progress: a smaller target and the digest of its plan. */
function downgradePending(fields: Fields): DowngradePendingV2 {
  exactObject(fields, "pending", ["kind", "revision", "target", "plan"]);
  const target = oneOf(fields.target, "pending.target", ["local-standard", "local-large"] as const);
  if (typeof fields.plan !== "string" || !/^[0-9a-f]{64}$/.test(fields.plan)) reject("pending.plan must be a SHA-256 digest");
  return { kind: "downgrade", revision: fields.revision as number, target, plan: fields.plan };
}

/** The pending transition, bound to the record's revision. */
function pending(value: unknown, revision: number): ScaleRecordV2["pending"] {
  if (value === null) return null;
  const fields = exactObject(value, "pending", ["kind", "revision"], ["target", "steps", "exceeds", "missing", "plan"]);
  if (count(fields.revision, "pending.revision") !== revision) reject("pending.revision must equal the record revision");
  const kind = oneOf(fields.kind, "pending.kind", ["prepare", "unavailable", "downgrade"] as const);
  if (kind === "downgrade") return downgradePending(fields);
  return kind === "prepare" ? preparePending(fields) : unavailablePending(fields);
}

/** The `local-v2` plan of the recorded estimate, which must reproduce the recorded figures exactly. */
function rederived(record: ScaleRecordV2): ScalePlanV2 {
  let plan: ScalePlanV2;
  try { plan = planRecordedV2(record.requested); } catch { reject("requested cannot be re-derived"); }
  if (!isDeepStrictEqual(plan.requested, record.requested)) reject("requested does not match its derivation");
  return plan;
}

/** The record must say what `local-v2` says about its own estimate and project. */
function assertCoherent(record: ScaleRecordV2): ScaleRecordV2 {
  const plan = rederived(record);
  const held = record.pending;
  if (held?.kind === "downgrade") assertDowngradeCoherent(record, plan, held);
  else if (plan.architecture === "unavailable") assertRecordedUnavailable(plan, held);
  else if (held?.kind === "unavailable") assertEligibilityBlock(record, plan, held);
  else assertTransitionMatches(record, plan, held);
  return record;
}

/** An estimate beyond the indexed envelope is recorded unavailable with exactly its excess and every missing backend. */
function assertRecordedUnavailable(plan: ScalePlanV2, held: ScaleRecordV2["pending"]): void {
  const exact = held?.kind === "unavailable" && isDeepStrictEqual(held.exceeds, plan.exceeds) && held.missing.length === MISSING_BACKENDS_V2.length;
  if (!exact) reject("an estimate beyond the indexed envelope must be recorded as unavailable with every missing backend");
}

/** An eligibility block (unavailable with no excess) belongs only to an indexed plan on a project that is not indexed. */
function assertEligibilityBlock(record: ScaleRecordV2, plan: ScalePlanV2, held: UnavailablePendingV2): void {
  if (held.exceeds.length > 0 || plan.architecture !== "local-indexed" || record.active.architecture === "local-indexed") {
    reject("an eligibility block is recorded only for an indexed plan on a project that is not indexed");
  }
}

/** A pending preparation exists exactly when the plan needs a transition, and targets the planned architecture. */
function assertTransitionMatches(record: ScaleRecordV2, plan: ScalePlanV2, held: PreparePendingV2 | null): void {
  const transition = needsTransitionV2(record.active.architecture, plan.architecture);
  if (transition !== (held !== null) || (held !== null && held.target !== plan.architecture)) reject("the pending transition does not match the plan");
}

/** A scale-down runs only from an active indexed project, toward a target its estimate fits. */
function assertDowngradeCoherent(record: ScaleRecordV2, plan: ScalePlanV2, held: DowngradePendingV2): void {
  if (record.active.architecture !== "local-indexed") reject("a scale-down is recorded only on an active local-indexed project");
  if (plan.architecture === "unavailable" || needsTransitionV2(held.target, plan.architecture)) reject("a scale-down's estimate must plan no larger than its target");
}

/** The closed capability list of a version 3 record: non-empty, known names, no duplicates. */
function capabilities(value: unknown): CapabilityV3[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITIES_V3.length) reject("capabilities must be a non-empty list of known capabilities");
  const list = value.map((item) => {
    const fields = exactObject(item, "capability", ["name", "status"]);
    return { name: oneOf(fields.name, "capability.name", CAPABILITIES_V3), status: oneOf(fields.status, "capability.status", ["preparing", "ready"] as const) };
  });
  if (new Set(list.map((item) => item.name)).size !== list.length) reject("a capability is listed twice");
  return list;
}

/** Capabilities belong only to an indexed project or one preparing to become indexed. */
function assertCapabilitiesHeld(record: ScaleRecordV2): void {
  const indexed = record.active.architecture === "local-indexed" || (record.pending?.kind === "prepare" && record.pending.target === "local-indexed");
  if (!indexed) reject("capabilities are recorded only on a project that is or is becoming local-indexed");
}

/** The record's exact fields, its version and policy checked. */
function recordFields(value: unknown, v3: boolean): Fields {
  const fields = exactObject(value, "record", ["version", "policy", "revision", "requested", "active", "pending", ...(v3 ? ["capabilities"] : [])]);
  if (fields.version !== 2 && fields.version !== 3) reject("record version must be 2 or 3");
  if (fields.policy !== SCALE_POLICY_V2) reject(`record policy must be ${SCALE_POLICY_V2}`);
  return fields;
}

/** Validate a parsed value as a version 2 record, or a version 3 record (version 2 plus capabilities). */
function validateScaleRecordV2(value: unknown): ScaleRecordV2 {
  const v3 = value !== null && typeof value === "object" && (value as Fields).version === 3;
  const fields = recordFields(value, v3);
  const revision = count(fields.revision, "revision");
  const record: ScaleRecordV2 = assertCoherent({
    version: v3 ? 3 : 2, policy: SCALE_POLICY_V2, revision,
    requested: requested(fields.requested), active: active(fields.active, revision), pending: pending(fields.pending, revision),
    ...(v3 ? { capabilities: capabilities(fields.capabilities) } : {}),
  });
  if (v3) assertCapabilitiesHeld(record);
  return record;
}

/** Parse record text of either version strictly; any other version is unreadable. */
export function parseAnyScaleRecord(text: string): ScaleRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { reject("record is not valid JSON"); }
  const version = value !== null && typeof value === "object" ? (value as Fields).version : undefined;
  if (version === 2 || version === 3) return validateScaleRecordV2(value);
  return parseScaleRecord(text);
}

/** Serialize a record of either version after validating it under its own policy. */
export function serializeAnyScaleRecord(record: ScaleRecord): string {
  if (record.version === 1) return serializeScaleRecord(record as ScaleRecordV1);
  const hasCapabilities = record.capabilities !== undefined;
  if ((record.version === 3) !== hasCapabilities) reject("a record carries capabilities exactly when it is version 3");
  return `${JSON.stringify(validateScaleRecordV2(record), null, 2)}\n`;
}
