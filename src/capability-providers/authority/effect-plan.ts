/**
 * @file src/capability-providers/authority/effect-plan.ts
 * @description Closed immutable effect-plan parsing and exact request matching.
 * Mutating work has no ambient authority: reversals are independent entries
 * with their own effect identity, request digest, and idempotency key.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import {
  captureDenseArray, captureExactRecord, captureOwnDataRecord,
} from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { MAX_MUTATING_EFFECTS_PER_CLASS } from "../constants.js";
import { parseBrokerId, parseEffectId, parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import type {
  EffectPlanEntryV1, ProviderEffectPlanV1, ProviderEffectRequestV1,
  ProviderRollbackSemanticsV1,
} from "./types.js";
import { parseProviderBounds } from "./grants-parse.js";

const MAX_EFFECTS = 256;
const MAX_BOUND_DIMENSIONS = 64;
const PLAN_KEYS = Object.freeze(["schemaVersion", "bounds", "entries"] as const);
const ENTRY_KEYS = Object.freeze([
  "effectId", "effectClass", "brokerId", "brokerContractVersion", "targetIdentity",
  "requestDigest", "idempotencyKey", "expectedBounds", "requiredConfirmationClass",
  "rollbackSemantics", "reversesEffectId",
] as const);

/** Capture and validate an immutable exact effect plan. */
export function parseEffectPlan(value: unknown): ProviderEffectPlanV1 {
  try {
    const plan = captureExactRecord(value, PLAN_KEYS);
    if (plan.schemaVersion !== 1) throw effectPlanError();
    const entries = captureDenseArray(plan.entries, MAX_EFFECTS, parseEntry, effectPlanError);
    validatePlanRelationships(entries);
    return Object.freeze({ schemaVersion: 1, bounds: parseProviderBounds(plan.bounds), entries });
  } catch (error) {
    if (error instanceof Error && /idempotency key is duplicate/.test(error.message)) throw error;
    throw effectPlanError();
  }
}

/** Bind a complete plan into preparation and grant authority. */
export function effectPlanDigest(plan: ProviderEffectPlanV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(parseEffectPlan(plan)));
}

/** Return one entry only when every request field matches its authorization. */
export function matchEffectPlanEntry(
  plan: ProviderEffectPlanV1,
  request: ProviderEffectRequestV1,
) {
  const snapshot = parseEffectPlan(plan);
  let requested: EffectPlanEntryV1;
  try { requested = parseEntry(request); }
  catch { throw effectNotApprovedError(); }
  const entry = snapshot.entries.find((candidate) => candidate.effectId === requested.effectId);
  if (!entry || canonicalDigest(entry) !== canonicalDigest(requested)) throw effectNotApprovedError();
  return Object.freeze({ entry, entryDigest: parseSha256Digest(canonicalDigest(entry)) });
}

function parseEntry(value: unknown): EffectPlanEntryV1 {
  const entry = captureExactRecord(value, ENTRY_KEYS);
  return Object.freeze({
    effectId: parseEffectId(entry.effectId), effectClass: token(entry.effectClass),
    brokerId: parseBrokerId(entry.brokerId), brokerContractVersion: token(entry.brokerContractVersion),
    targetIdentity: target(entry.targetIdentity), requestDigest: parseSha256Digest(entry.requestDigest),
    idempotencyKey: token(entry.idempotencyKey), expectedBounds: parseExpectedBounds(entry.expectedBounds),
    requiredConfirmationClass: token(entry.requiredConfirmationClass),
    rollbackSemantics: rollbackSemantics(entry.rollbackSemantics),
    reversesEffectId: entry.reversesEffectId === null ? null : parseEffectId(entry.reversesEffectId),
  });
}

function validatePlanRelationships(entries: readonly EffectPlanEntryV1[]): void {
  const effects = new Map(entries.map((entry) => [entry.effectId, entry]));
  const indexes = new Map(entries.map((entry, index) => [entry.effectId, index]));
  if (effects.size !== entries.length) throw effectPlanError();
  const idempotencyKeys = entries.map((entry) => entry.idempotencyKey);
  if (new Set(idempotencyKeys).size !== idempotencyKeys.length) {
    throw new Error("provider effect plan idempotency key is duplicate");
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.reversesEffectId === null) continue;
    const original = effects.get(entry.reversesEffectId);
    const originalIndex = indexes.get(entry.reversesEffectId);
    if (!original || originalIndex === undefined || originalIndex >= index || original.rollbackSemantics === "none") {
      throw effectPlanError();
    }
  }
  validateEffectClassCounts(entries);
}

function validateEffectClassCounts(entries: readonly EffectPlanEntryV1[]): void {
  const classCounts = new Map<string, number>();
  for (const entry of entries) {
    const count = (classCounts.get(entry.effectClass) ?? 0) + 1;
    if (count > MAX_MUTATING_EFFECTS_PER_CLASS) throw effectPlanError();
    classCounts.set(entry.effectClass, count);
  }
}

function parseExpectedBounds(value: unknown): Readonly<Record<string, number>> {
  const record = captureOwnDataRecord(value);
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.length > MAX_BOUND_DIMENSIONS) throw effectPlanError();
  const result = Object.create(null) as Record<string, number>;
  for (const key of keys.sort()) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)) throw effectPlanError();
    const candidate = record[key];
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) throw effectPlanError();
    result[key] = Number(candidate);
  }
  return Object.freeze(result);
}

function rollbackSemantics(value: unknown): ProviderRollbackSemanticsV1 {
  if (value !== "none" && value !== "broker-reversible" && value !== "follow-up-effect-only") {
    throw effectPlanError();
  }
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw effectPlanError();
  return value;
}
function target(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value === "*" || !isWellFormedUnicode(value)) throw effectPlanError();
  if (/[\u0000-\u001f\u007f]/.test(value)) throw effectPlanError();
  return value;
}
function effectPlanError(): Error { return new Error("provider effect plan is invalid"); }
function effectNotApprovedError(): Error { return new Error("provider effect is not approved"); }
