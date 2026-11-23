/**
 * @file src/scale/record-schema.ts
 * @description The STRICT, CLOSED schema of `.llmwiki/scale.json`, version 1.
 *
 * A record is accepted only when every object has exactly its known keys,
 * every enum holds a known value, every count is a positive safe integer, the
 * revisions agree (`pending.revision === revision`, `active.sinceRevision <=
 * revision`), a prepare transition lists exactly the known steps in order, and
 * an unavailable one names a non-empty, duplicate-free subset of the known
 * bounds and backends. Anything else is unreadable: the caller fails closed and
 * nothing is repaired, guessed or defaulted.
 *
 * A WELL-FORMED BUT CONTRADICTORY record fails closed too: at least one figure
 * must be stated and a derived figure must match its derivation, an estimate the planning policy calls
 * unavailable must be recorded as unavailable (with exactly the exceeded
 * bounds and every missing backend), and otherwise the record must carry a
 * prepare transition exactly when the active architecture is smaller than the
 * plan. A record written under a different planning policy is therefore
 * unreadable to this build rather than silently reinterpreted.
 */

import { isDeepStrictEqual } from "node:util";
import {
  MAX_STEP_DETAIL_CHARS, MISSING_BACKENDS, PREPARATION_STEPS, SCALE_RECORD_VERSION,
  type ActiveArchitectureV1, type PreparePendingV1, type RequestedScaleV1, type ScalePlan, type ScaleRecordV1, type StepRecordV1,
  type UnavailablePendingV1,
} from "./contracts.js";
import { needsTransition, planRecorded } from "./plan.js";

/** Why a record failed validation; carried as the unreadable reason. */
export class ScaleRecordSchemaError extends Error {}

/** A validated plain object's fields. */
export type Fields = Record<string, unknown>;

/** Fail validation with `reason`. */
export function reject(reason: string): never {
  throw new ScaleRecordSchemaError(reason);
}

/** A plain object with exactly `required` keys plus any of `optional`. */
export function exactObject(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  const keys = Object.keys(value);
  const known = new Set([...required, ...optional]);
  if (keys.some((key) => !known.has(key))) reject(`${label} has an unknown key`);
  if (required.some((key) => !Object.hasOwn(value, key))) reject(`${label} is missing a key`);
  return value as Fields;
}

/** A positive safe integer. */
export function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) reject(`${label} must be a positive safe integer`);
  return value;
}

/** One of `allowed`. */
export function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) reject(`${label} has an unknown value`);
  return value as T;
}

/** A non-empty, duplicate-free list drawn from `allowed`, in `allowed` order. */
export function orderedSubset<T extends string>(value: unknown, label: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0) reject(`${label} must be a non-empty list`);
  const items = value.map((item) => oneOf(item, label, allowed));
  const canonical = allowed.filter((item) => items.includes(item));
  if (canonical.length !== items.length || canonical.some((item, at) => item !== items[at])) reject(`${label} must be ordered and unique`);
  return items;
}

/** The recorded estimate. */
export function requested(value: unknown): RequestedScaleV1 {
  const fields = exactObject(value, "requested", ["sizeBytes", "documents", "sizeBasis", "documentsBasis"]);
  const basis = ["stated", "derived"] as const;
  const recorded: RequestedScaleV1 = {
    sizeBytes: count(fields.sizeBytes, "requested.sizeBytes"),
    documents: count(fields.documents, "requested.documents"),
    sizeBasis: oneOf(fields.sizeBasis, "requested.sizeBasis", basis),
    documentsBasis: oneOf(fields.documentsBasis, "requested.documentsBasis", basis),
  };
  if (recorded.sizeBasis === "derived" && recorded.documentsBasis === "derived") reject("requested must state at least one figure");
  return recorded;
}

/** The active architecture; never later than the record's revision. */
function active(value: unknown, revision: number): ActiveArchitectureV1 {
  const fields = exactObject(value, "active", ["architecture", "sinceRevision"]);
  const sinceRevision = count(fields.sinceRevision, "active.sinceRevision");
  if (sinceRevision > revision) reject("active.sinceRevision is later than the record revision");
  return { architecture: oneOf(fields.architecture, "active.architecture", ["local-standard", "local-large"] as const), sinceRevision };
}

/** One step's progress at its fixed position. */
function step(value: unknown, at: number): StepRecordV1 {
  const fields = exactObject(value, "step", ["name", "status"], ["detail"]);
  if (fields.name !== PREPARATION_STEPS[at]) reject("steps must list the known steps in order");
  const status = oneOf(fields.status, "step.status", ["pending", "done", "parked"] as const);
  if (fields.detail === undefined) return { name: PREPARATION_STEPS[at]!, status };
  if (typeof fields.detail !== "string" || fields.detail.length > MAX_STEP_DETAIL_CHARS) reject("step.detail must be a bounded string");
  return { name: PREPARATION_STEPS[at]!, status, detail: fields.detail };
}

/** A prepare transition. */
function preparePending(fields: Fields): PreparePendingV1 {
  exactObject(fields, "pending", ["kind", "revision", "target", "steps"]);
  oneOf(fields.target, "pending.target", ["local-large"] as const);
  if (!Array.isArray(fields.steps) || fields.steps.length !== PREPARATION_STEPS.length) reject("pending.steps must list every step");
  return { kind: "prepare", revision: fields.revision as number, target: "local-large", steps: fields.steps.map(step) };
}

/** A recorded unavailable estimate. */
function unavailablePending(fields: Fields): UnavailablePendingV1 {
  exactObject(fields, "pending", ["kind", "revision", "exceeds", "missing"]);
  return {
    kind: "unavailable", revision: fields.revision as number,
    exceeds: orderedSubset(fields.exceeds, "pending.exceeds", ["documents", "bytes"] as const),
    missing: orderedSubset(fields.missing, "pending.missing", MISSING_BACKENDS),
  };
}

/** The pending transition, bound to the record's revision. */
function pending(value: unknown, revision: number): ScaleRecordV1["pending"] {
  if (value === null) return null;
  const fields = exactObject(value, "pending", ["kind", "revision"], ["target", "steps", "exceeds", "missing"]);
  if (count(fields.revision, "pending.revision") !== revision) reject("pending.revision must equal the record revision");
  const kind = oneOf(fields.kind, "pending.kind", ["prepare", "unavailable"] as const);
  return kind === "prepare" ? preparePending(fields) : unavailablePending(fields);
}

/** The plan for the recorded estimate, which must reproduce the recorded figures exactly. */
function rederivedPlan(requested: RequestedScaleV1): ScalePlan {
  let plan: ScalePlan;
  try { plan = planRecorded(requested); } catch { reject("requested cannot be re-derived"); }
  if (!isDeepStrictEqual(plan.requested, requested)) reject("requested does not match its derivation");
  return plan;
}

/** Whether `pending` records exactly the unavailable outcome `plan` describes. */
function recordsUnavailable(pending: ScaleRecordV1["pending"], plan: ScalePlan): boolean {
  return pending?.kind === "unavailable" && isDeepStrictEqual(pending.exceeds, plan.exceeds) && pending.missing.length === MISSING_BACKENDS.length;
}

/** The record must say what the planning policy says about its own estimate. */
function assertCoherent(record: ScaleRecordV1): ScaleRecordV1 {
  const plan = rederivedPlan(record.requested);
  if (plan.architecture === "unavailable") {
    if (!recordsUnavailable(record.pending, plan)) reject("an estimate beyond the local envelope must be recorded as unavailable");
    return record;
  }
  const expected = needsTransition(record.active.architecture, plan.architecture) ? "prepare" : null;
  if ((record.pending?.kind ?? null) !== expected) reject("the pending transition does not match the plan");
  return record;
}

/** Validate a parsed value as a version 1 record, or throw {@link ScaleRecordSchemaError}. */
function validateScaleRecord(value: unknown): ScaleRecordV1 {
  const fields = exactObject(value, "record", ["version", "revision", "requested", "active", "pending"]);
  if (fields.version !== SCALE_RECORD_VERSION) reject(`record version must be ${SCALE_RECORD_VERSION}`);
  const revision = count(fields.revision, "revision");
  return assertCoherent({
    version: 1, revision,
    requested: requested(fields.requested),
    active: active(fields.active, revision),
    pending: pending(fields.pending, revision),
  });
}

/** Parse record text strictly: JSON first, then the closed schema. */
export function parseScaleRecord(text: string): ScaleRecordV1 {
  let value: unknown;
  try { value = JSON.parse(text); } catch { reject("record is not valid JSON"); }
  return validateScaleRecord(value);
}

/** Serialize a record after validating it, so an invalid record is never written. */
export function serializeScaleRecord(record: ScaleRecordV1): string {
  return `${JSON.stringify(validateScaleRecord(record), null, 2)}\n`;
}
