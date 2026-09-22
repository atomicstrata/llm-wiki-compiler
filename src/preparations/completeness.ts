/**
 * @file src/preparations/completeness.ts
 * @description Completeness is HOST AUTHORITY (design section 19). The eleven
 * closed identity categories are the only completeness input: a class supplies
 * canonical sorted identity SETS, and every counter in the emitted
 * `CompletionClassV1` is DERIVED from a set's size. No provider count, coverage
 * claim, confidence, or completion assertion can move a counter — a provider
 * report is compared in {@link compareProviderCompletionClaim} and can only
 * produce a fixed-code notice. The set equations are enforced before any counter
 * exists, so `unavailable` can never be counted as `skipped`, `cancelled` can
 * never be counted as `failed`, map `overflow` can never be counted as
 * materialized work, and a `nonConverged` repeat can never be counted as
 * converged. A required deficit blocks terminal success and handoff; an optional
 * deficit yields an exact warning naming the missing identities.
 *
 * Every exported entry point CAPTURES its inputs through the canonical runtime
 * primitives before reading any field, and reads only from that copy — including
 * each class's container and each class input. Reading a caller's field twice is
 * how an accessor answers a validation one way and the use that follows another.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import {
  captureDenseArray, captureExactRecord, captureOwnDataRecord, deepCaptureData,
} from "../utils/runtime-capture.js";
import { captureEvidenceRef } from "./evidence-capture.js";
import { assertSafeComponent } from "./ids.js";
import type { CompletenessRecordV1, RunCompletionWarningV1, RunNoticeV1 } from "./run-types.js";
import type { EvidenceRefV1, Sha256Digest } from "./types.js";

/**
 * The ELEVEN and only completeness categories. This single list drives capture,
 * counter derivation, the provider-claim comparison, and the class-shape
 * invariant test, so a future category cannot escape classification.
 */
export const COMPLETENESS_CATEGORIES = Object.freeze([
  "planned", "eligible", "attempted", "completed", "included", "skipped",
  "unavailable", "failed", "cancelled", "overflow", "nonConverged",
] as const);

export type CompletenessCategory = (typeof COMPLETENESS_CATEGORIES)[number];

/** The non-counter fields of a completion class; the counters are the categories. */
export const COMPLETION_CLASS_IDENTITY_KEYS = Object.freeze([
  "classId", "disposition", "identitySetRef",
] as const);

/** The outcome categories that must exactly and disjointly cover `eligible`. */
const OUTCOME_CATEGORIES = Object.freeze([
  "completed", "skipped", "unavailable", "failed", "cancelled", "nonConverged",
] as const);

/** Every `child ⊆ parent` containment the identity-set equation enforces. */
const CONTAINMENTS: ReadonlyArray<readonly [CompletenessCategory, CompletenessCategory]> = Object.freeze([
  ["eligible", "planned"], ["attempted", "eligible"], ["completed", "attempted"],
  ["included", "completed"], ["overflow", "planned"], ["skipped", "eligible"],
  ["unavailable", "eligible"], ["failed", "eligible"], ["cancelled", "eligible"],
  ["nonConverged", "eligible"],
] as const);

const MAX_IDENTITIES_PER_CATEGORY = 4_096;
const MAX_COMPLETION_CLASSES = 64;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCOPE_DOMAIN = "llmwiki-preparation-completeness-scope-v1";
const SETS_DOMAIN = "llmwiki-preparation-completeness-sets-v1";
const DEFICIT_DOMAIN = "llmwiki-preparation-completeness-deficit-v1";

/** The fixed warning code for exact optional incompleteness. */
export const OPTIONAL_DEFICIT_CODE = "preparation-optional-completeness-deficit";
/** The fixed notice code raised when a provider count disagrees with the host. */
export const PROVIDER_COUNT_MISMATCH_CODE = "preparation-provider-count-mismatch";

/** Closed reason a completeness derivation failed closed. */
export type CompletenessCode =
  | "invalid-identity-sets" | "duplicate-identity" | "missing-category" | "unknown-category"
  | "identity-cap-exceeded" | "set-not-contained" | "categories-overlap"
  | "outcome-coverage-mismatch" | "overflow-materialized" | "invalid-class"
  | "duplicate-class" | "class-cap-exceeded" | "required-deficit"
  | "invalid-scope" | "invalid-identity-set-ref" | "deficit-mismatch";

/** Typed refusal raised for every completeness authority failure. */
export class CompletenessAuthorityError extends Error {
  readonly code: CompletenessCode;
  constructor(code: CompletenessCode) {
    super(`preparation completeness authority: ${code}`);
    this.name = "CompletenessAuthorityError";
    this.code = code;
  }
}

/** Canonical sorted immutable identity sets for one completion class. */
export type CompletenessIdentitySetsV1 = Readonly<Record<CompletenessCategory, readonly string[]>>;

/** One completion class: its identity binding plus the eleven derived counters. */
export type CompletionClassV1 = Readonly<Record<CompletenessCategory, number>> & {
  readonly classId: string;
  readonly disposition: "required" | "optional";
  readonly identitySetRef: EvidenceRefV1;
};

/** The bounded host completeness record derived after phase settlement (19.1). */
export interface PreparationCompletenessV1 {
  readonly schemaVersion: 1;
  readonly scopeDigest: Sha256Digest;
  readonly classes: readonly CompletionClassV1[];
  readonly requiredDeficitCount: number;
  readonly optionalDeficitCount: number;
  readonly identitySetsDigest: Sha256Digest;
}

/** One class's declared contract plus its untrusted-shaped identity sets. */
export interface CompletionClassInputV1 {
  readonly classId: string;
  readonly disposition: "required" | "optional";
  readonly identitySetRef: EvidenceRefV1;
  readonly identitySets: unknown;
}

/** Exact optional incompleteness, naming the identities that are missing. */
export interface CompletionWarningV1 {
  readonly code: typeof OPTIONAL_DEFICIT_CODE;
  readonly classId: string;
  readonly deficitCount: number;
  readonly deficitIdentities: readonly string[];
  readonly identityDigest: Sha256Digest;
  readonly attempted: number;
  readonly completed: number;
  readonly skipped: number;
  readonly failed: number;
}

/** The complete derivation: the record, exact warnings, and per-class deficits. */
export interface CompletenessDerivationV1 {
  readonly record: PreparationCompletenessV1;
  readonly warnings: readonly CompletionWarningV1[];
  readonly deficits: Readonly<Record<string, readonly string[]>>;
}

/** Capture one category's identities as a canonical sorted duplicate-free set. */
function captureCategory(value: unknown): readonly string[] {
  let items: readonly string[];
  try {
    items = captureDenseArray(value, MAX_IDENTITIES_PER_CATEGORY, (item) => {
      if (typeof item !== "string" || !IDENTITY_PATTERN.test(item)) {
        throw new CompletenessAuthorityError("invalid-identity-sets");
      }
      return item;
    }, () => new CompletenessAuthorityError("identity-cap-exceeded"));
  } catch (error) {
    throw error instanceof CompletenessAuthorityError ? error : new CompletenessAuthorityError("invalid-identity-sets");
  }
  const sorted = [...items].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) throw new CompletenessAuthorityError("duplicate-identity");
  }
  return Object.freeze(sorted);
}

/**
 * Deep-capture one untrusted identity-set record against the CLOSED category
 * allowlist. An extra key (a smuggled provider counter) and a missing category
 * are distinct fail-closed refusals; neither is tolerated.
 */
export function captureIdentitySets(value: unknown): CompletenessIdentitySetsV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(value);
  } catch {
    throw new CompletenessAuthorityError("invalid-identity-sets");
  }
  const known = new Set<string>(COMPLETENESS_CATEGORIES);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new CompletenessAuthorityError("unknown-category");
  }
  const sets = Object.create(null) as Record<CompletenessCategory, readonly string[]>;
  for (const category of COMPLETENESS_CATEGORIES) {
    if (record[category] === undefined) throw new CompletenessAuthorityError("missing-category");
    sets[category] = captureCategory(record[category]);
  }
  return Object.freeze(sets);
}

/**
 * Enforce the identity-set equations BEFORE any counter exists: every nested
 * category is contained by its parent, the outcome categories are pairwise
 * disjoint and exactly cover `eligible`, and an overflow identity was never
 * materialized. This is what makes each counter a fact rather than a claim.
 */
export function assertIdentitySetEquations(value: CompletenessIdentitySetsV1): void {
  const sets = captureIdentitySets(value);
  for (const [child, parent] of CONTAINMENTS) {
    const universe = new Set(sets[parent]);
    if (sets[child].some((identity) => !universe.has(identity))) {
      throw new CompletenessAuthorityError("set-not-contained");
    }
  }
  const covered = new Set<string>();
  for (const category of OUTCOME_CATEGORIES) {
    for (const identity of sets[category]) {
      if (covered.has(identity)) throw new CompletenessAuthorityError("categories-overlap");
      covered.add(identity);
    }
  }
  if (covered.size !== sets.eligible.length) throw new CompletenessAuthorityError("outcome-coverage-mismatch");
  const eligible = new Set(sets.eligible);
  if (sets.overflow.some((identity) => eligible.has(identity))) {
    throw new CompletenessAuthorityError("overflow-materialized");
  }
}

/** One validated class: its derived counters, canonical sets, and deficit ids. */
interface DerivedClass {
  readonly counters: CompletionClassV1;
  readonly sets: CompletenessIdentitySetsV1;
  readonly deficits: readonly string[];
}

/** The four fields one class input may carry; an extra key fails closed. */
const CLASS_INPUT_KEYS = Object.freeze([
  "classId", "disposition", "identitySetRef", "identitySets",
] as const);

/** The two keys of the derivation input itself. */
const DERIVE_INPUT_KEYS = Object.freeze(["scopeId", "classes"] as const);

/** One class input captured ONCE; every later read comes from this copy. */
interface CapturedClassInput {
  readonly classId: string;
  readonly disposition: "required" | "optional";
  readonly identitySetRef: EvidenceRefV1;
  readonly identitySets: unknown;
}

/**
 * Capture one untrusted-shaped class input into an immutable copy. Reading a
 * field twice from the caller's object is what lets an accessor answer
 * `required` to a validation and `optional` to the use that follows, so the
 * capture happens ONCE here and {@link deriveClass} never sees the original.
 */
function captureClassInput(value: unknown): CapturedClassInput {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureExactRecord(value, CLASS_INPUT_KEYS);
  } catch {
    throw new CompletenessAuthorityError("invalid-class");
  }
  const disposition = record.disposition;
  if (disposition !== "required" && disposition !== "optional") {
    throw new CompletenessAuthorityError("invalid-class");
  }
  let classId: string;
  try {
    classId = assertSafeComponent(record.classId);
  } catch {
    throw new CompletenessAuthorityError("invalid-class");
  }
  return Object.freeze({
    classId, disposition, identitySets: record.identitySets,
    identitySetRef: captureIdentitySetRef(record.identitySetRef),
  });
}

/** Capture and validate the per-class evidence pointer that a digest binds. */
function captureIdentitySetRef(value: unknown): EvidenceRefV1 {
  try {
    return captureEvidenceRef(value);
  } catch {
    throw new CompletenessAuthorityError("invalid-identity-set-ref");
  }
}

/** Derive one completion class; every counter is a set size, never an input. */
function deriveClass(input: CapturedClassInput): DerivedClass {
  const sets = captureIdentitySets(input.identitySets);
  assertIdentitySetEquations(sets);
  const counters = Object.create(null) as Record<CompletenessCategory, number>;
  for (const category of COMPLETENESS_CATEGORIES) counters[category] = sets[category].length;
  const included = new Set(sets.included);
  return {
    counters: Object.freeze({
      classId: input.classId, disposition: input.disposition,
      identitySetRef: input.identitySetRef, ...counters,
    }),
    sets,
    deficits: Object.freeze(sets.planned.filter((identity) => !included.has(identity))),
  };
}

/** Build the exact optional-incompleteness warning for one deficient class. */
function warningFor(derived: DerivedClass): CompletionWarningV1 {
  const { counters, deficits } = derived;
  return Object.freeze({
    code: OPTIONAL_DEFICIT_CODE, classId: counters.classId, deficitCount: deficits.length,
    deficitIdentities: deficits,
    identityDigest: parseSha256Digest(canonicalDigest({
      domain: DEFICIT_DOMAIN, classId: counters.classId, identities: deficits,
    })),
    attempted: counters.attempted, completed: counters.completed,
    skipped: counters.skipped, failed: counters.failed,
  });
}

/** Sum the deficit identities of every class with the given disposition. */
function deficitTotal(classes: readonly DerivedClass[], disposition: "required" | "optional"): number {
  return classes
    .filter((derived) => derived.counters.disposition === disposition)
    .reduce((total, derived) => total + derived.deficits.length, 0);
}

/**
 * Derive the bounded host completeness record for one scope. The scope digest
 * binds only the declared class contract (so it is stable while work proceeds);
 * the identity-set digest binds every canonical set, so a changed eligibility
 * universe produces a different record and invalidates whatever depended on it.
 */
export function deriveCompleteness(input: {
  scopeId: string;
  classes: readonly CompletionClassInputV1[];
}): CompletenessDerivationV1 {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureExactRecord(input, DERIVE_INPUT_KEYS);
  } catch {
    throw new CompletenessAuthorityError("invalid-scope");
  }
  let scopeId: string;
  try {
    scopeId = assertSafeComponent(record.scopeId);
  } catch {
    throw new CompletenessAuthorityError("invalid-scope");
  }
  const derived = captureDerivedClasses(record.classes);
  return Object.freeze({
    record: completenessRecordFor(scopeId, derived),
    warnings: Object.freeze(derived.filter((entry) =>
      entry.counters.disposition === "optional" && entry.deficits.length > 0).map(warningFor)),
    deficits: deficitsByClass(derived),
  });
}

/**
 * Capture the class container through the canonical dense-array primitive so the
 * class cap is enforced on a real array. An array-like carrying its own `map`
 * would otherwise return whatever class records it liked without a single one
 * passing {@link deriveClass} or the identity-set equations.
 */
function captureDerivedClasses(value: unknown): readonly DerivedClass[] {
  let captured: readonly CapturedClassInput[];
  try {
    captured = captureDenseArray(value, MAX_COMPLETION_CLASSES, captureClassInput,
      () => new CompletenessAuthorityError("class-cap-exceeded"));
  } catch (error) {
    throw error instanceof CompletenessAuthorityError
      ? error : new CompletenessAuthorityError("invalid-class");
  }
  if (captured.length === 0) throw new CompletenessAuthorityError("class-cap-exceeded");
  const derived = captured.map(deriveClass);
  if (new Set(derived.map((entry) => entry.counters.classId)).size !== derived.length) {
    throw new CompletenessAuthorityError("duplicate-class");
  }
  return derived;
}

/** Index every class's deficit identities by class id. */
function deficitsByClass(derived: readonly DerivedClass[]): Readonly<Record<string, readonly string[]>> {
  const deficits = Object.create(null) as Record<string, readonly string[]>;
  for (const entry of derived) deficits[entry.counters.classId] = entry.deficits;
  return Object.freeze(deficits);
}

/**
 * Build the bounded host record. `scopeDigest` binds ONLY the declared class
 * contract and is deliberately STABLE while work proceeds; `identitySetsDigest`
 * binds every canonical set AND every per-class evidence pointer, so a changed
 * eligibility universe moves that digest alone (see the note at the consumer in
 * {@link toRunCompletenessRecord}).
 */
function completenessRecordFor(
  scopeId: string, derived: readonly DerivedClass[],
): PreparationCompletenessV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    scopeDigest: parseSha256Digest(canonicalDigest({
      domain: SCOPE_DOMAIN, scopeId,
      classes: derived.map((entry) => ({
        classId: entry.counters.classId, disposition: entry.counters.disposition,
      })),
    })),
    classes: Object.freeze(derived.map((entry) => entry.counters)),
    requiredDeficitCount: deficitTotal(derived, "required"),
    optionalDeficitCount: deficitTotal(derived, "optional"),
    identitySetsDigest: parseSha256Digest(canonicalDigest({
      domain: SETS_DOMAIN,
      classes: derived.map((entry) => ({
        classId: entry.counters.classId, identitySetRef: entry.counters.identitySetRef,
        sets: entry.sets,
      })),
    })),
  });
}

/**
 * Capture one completeness record at a CONSUMER: the record itself and its class
 * container, through the canonical primitives. A derived record is not trusted
 * merely because a producer once derived one.
 */
function captureRecord(record: PreparationCompletenessV1): Readonly<Record<string, unknown>> {
  try {
    return captureOwnDataRecord(record);
  } catch {
    throw new CompletenessAuthorityError("invalid-class");
  }
}

/** Capture one captured record's class container by own numeric descriptors. */
function capturedClasses(
  captured: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  try {
    return captureDenseArray(captured.classes, MAX_COMPLETION_CLASSES, captureOwnDataRecord,
      () => new CompletenessAuthorityError("class-cap-exceeded"));
  } catch (error) {
    throw error instanceof CompletenessAuthorityError
      ? error : new CompletenessAuthorityError("invalid-class");
  }
}

/** Read one non-negative derived counter from a captured class record. */
function counterOf(entry: Readonly<Record<string, unknown>>, key: string): number {
  const value = entry[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CompletenessAuthorityError("deficit-mismatch");
  }
  return value;
}

/**
 * Recompute BOTH deficit totals from the record's own per-class `planned` and
 * `included` counters and refuse a record whose stored totals disagree. Derived
 * is not trusted at the producer alone: the consumer that blocks terminal
 * success must derive the number it acts on, or a stored `0` launders a real
 * required deficit into silence.
 */
function assertDeficitCountsDerived(record: PreparationCompletenessV1): void {
  const captured = captureRecord(record);
  const totals = { required: 0, optional: 0 };
  for (const entry of capturedClasses(captured)) {
    const deficit = counterOf(entry, "planned") - counterOf(entry, "included");
    if (deficit < 0) throw new CompletenessAuthorityError("deficit-mismatch");
    if (entry.disposition !== "required" && entry.disposition !== "optional") {
      throw new CompletenessAuthorityError("deficit-mismatch");
    }
    totals[entry.disposition] += deficit;
  }
  if (totals.required !== captured.requiredDeficitCount
    || totals.optional !== captured.optionalDeficitCount) {
    throw new CompletenessAuthorityError("deficit-mismatch");
  }
}

/**
 * Fail closed unless completeness permits terminal success AND bundle handoff.
 * Any required deficit — a missing, skipped, unavailable, failed, cancelled,
 * overflowed, or non-converged required identity — blocks both. The deficit is
 * RECOMPUTED here rather than read, so the gate cannot be satisfied by a stored
 * counter that the record's own per-class numbers contradict.
 */
export function assertCompletenessPermitsSuccess(record: PreparationCompletenessV1): void {
  assertDeficitCountsDerived(record);
  if (record.requiredDeficitCount !== 0) throw new CompletenessAuthorityError("required-deficit");
}

/** Sum one derived counter across every class of the captured record. */
export function completenessTotal(record: PreparationCompletenessV1, category: CompletenessCategory): number {
  return capturedClasses(captureRecord(record))
    .reduce((total, entry) => total + counterOf(entry, category), 0);
}

/**
 * Project the host record onto the landed run-store completeness record.
 *
 * The projected `classDigest` is `identitySetsDigest`, NOT `scopeDigest`, and
 * that choice is deliberate: `scopeDigest` binds only the declared class
 * contract and is designed to stay STABLE while work proceeds, so a consumer
 * keyed on it would see no change when the eligibility universe changes. Only
 * `identitySetsDigest` moves with the sets and their evidence pointers, so it is
 * the only digest a dependent phase input, gate, or handoff may key on.
 */
export function toRunCompletenessRecord(record: PreparationCompletenessV1): CompletenessRecordV1 {
  const captured = captureRecord(record);
  assertDeficitCountsDerived(record);
  return {
    requiredDeficit: captured.requiredDeficitCount as number,
    optionalDeficit: captured.optionalDeficitCount as number,
    classDigest: parseSha256Digest(captured.identitySetsDigest),
  };
}

/** Project one exact warning onto the landed run-store completion warning. */
export function toRunCompletionWarning(warning: CompletionWarningV1): RunCompletionWarningV1 {
  let captured: Readonly<Record<string, unknown>>;
  try {
    captured = captureOwnDataRecord(warning);
  } catch {
    throw new CompletenessAuthorityError("invalid-class");
  }
  return {
    code: captured.code as typeof OPTIONAL_DEFICIT_CODE,
    attempted: counterOf(captured, "attempted"), completed: counterOf(captured, "completed"),
    skipped: counterOf(captured, "skipped"), failed: counterOf(captured, "failed"),
  };
}

/**
 * Compare an UNTRUSTED provider completion report against the host-derived
 * record. The report can only produce a fixed-code notice: it never enters the
 * record, never adjusts a counter, and never suppresses a deficit. An unreadable
 * report is itself a notice rather than silent agreement.
 */
export function compareProviderCompletionClaim(input: {
  claim: unknown;
  derived: PreparationCompletenessV1;
}): readonly RunNoticeV1[] {
  let request: Readonly<Record<string, unknown>>;
  try {
    request = captureExactRecord(input, ["claim", "derived"]);
  } catch {
    throw new CompletenessAuthorityError("invalid-class");
  }
  const derived = request.derived as PreparationCompletenessV1;
  let claim: Readonly<Record<string, unknown>>;
  try {
    claim = captureOwnDataRecord(deepCaptureData(request.claim));
  } catch {
    return Object.freeze([Object.freeze({ code: PROVIDER_COUNT_MISMATCH_CODE })]);
  }
  const disagrees = COMPLETENESS_CATEGORIES.some((category) =>
    claim[category] !== undefined && claim[category] !== completenessTotal(derived, category));
  return disagrees
    ? Object.freeze([Object.freeze({ code: PROVIDER_COUNT_MISMATCH_CODE })])
    : Object.freeze([]);
}
