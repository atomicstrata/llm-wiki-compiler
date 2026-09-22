/**
 * @file src/operations-packs/values.ts
 * @description Shared bounded-value readers for the operations-pack grammar,
 * layered on the repository's canonical-JSON value helpers. These rebuild typed
 * scalar lists, closed string sets, finite numbers, safe integers, and the
 * concrete input-value form without ever accepting an executable value. Every
 * reader is total and fails closed; duplicate detection is explicit so a
 * collection's identities stay distinct before composition trusts them.
 */

import { Buffer } from "node:buffer";
import { array, count, record, textValue } from "../operation-bundles/manifest-values.js";
import { FORBIDDEN_PACK_TEXT_CONTROL, MAX_DEFAULT_STRING_BYTES, MAX_DEFAULT_VALUE_ITEMS } from "./constants.js";
import { assertPackDigest, assertRefId, assertSlug, type Sha256Digest } from "./ids.js";
import { PackDeferredError, PackParseError } from "./problems.js";
import type { PackActionInputScalarV2, PackActionInputValueV2 } from "./types.js";

const LOWEST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/** Require a positive safe-integer bound of at least one unit. */
export function positiveCount(value: unknown, label: string): number {
  const parsed = count(value, label);
  if (parsed < 1) throw new PackParseError(`${label} must be at least one`);
  return parsed;
}

/** True when a string carries an ASCII control character (never allowed in data). */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < LOWEST_PRINTABLE_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

/** Reject duplicate strings in one bounded parsed list. */
export function assertUniqueStrings(items: readonly string[], label: string): readonly string[] {
  if (new Set(items).size !== items.length) throw new PackParseError(`${label} contains duplicate values`);
  return items;
}

/** Parse a bounded list of distinct slug identifiers. */
export function slugList(value: unknown, label: string, cap: number): string[] {
  return [...assertUniqueStrings(array(value, label, cap).map((item) => assertSlug(item)), label)];
}

/** Parse a bounded list of distinct reference identifiers. */
export function refList(value: unknown, label: string, cap: number): string[] {
  return [...assertUniqueStrings(array(value, label, cap).map((item) => assertRefId(item)), label)];
}

/** Parse a bounded list of distinct content digests. */
export function digestList(value: unknown, label: string, cap: number): Sha256Digest[] {
  const digests = array(value, label, cap).map((item) => assertPackDigest(item));
  assertUniqueStrings(digests, label);
  return digests;
}

/** Parse one nonempty bounded closed set of distinct string values. */
export function closedValueSet(value: unknown, label: string, cap: number): string[] {
  const values = array(value, label, cap)
    .map((item, index) => textValue(item, `${label}[${index}]`, MAX_DEFAULT_STRING_BYTES));
  if (values.length === 0) throw new PackParseError(`${label} must declare at least one value`);
  return [...assertUniqueStrings(values, label)];
}

/** Parse one finite number without coercion (e.g. a `number` field bound). */
export function finiteNumberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PackParseError(`${label} must be a finite number`);
  }
  return value;
}

/** Parse one finite safe integer without coercion (e.g. an `integer` field bound). */
export function safeIntegerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PackParseError(`${label} must be a safe integer`);
  }
  return value;
}

/**
 * Parse one bounded object map: every key is validated by `keyAssert` and every
 * value by `parseEntry`. Keys are grammar-checked before assignment so a reserved
 * or prototype-polluting key can never name an entry.
 */
export function parseObjectMap<T>(
  value: unknown,
  label: string,
  cap: number,
  keyAssert: (key: unknown) => string,
  parseEntry: (entryValue: unknown, entryLabel: string) => T,
): Record<string, T> {
  const node = record(value, label);
  const keys = Object.keys(node);
  if (keys.length > cap) throw new PackParseError(`${label} exceeds its entry cap`);
  const out: Record<string, T> = {};
  for (const key of keys) {
    keyAssert(key);
    out[key] = parseEntry(node[key], `${label}.${key}`);
  }
  return out;
}

/**
 * Parse one PACK-AUTHORED constant/parameter scalar (a rule parameter or intent
 * constant value; sections 16.4, 16.7). Only a boolean or finite number is
 * accepted here: a STRING constant must be validated against the owning registered
 * rule/target schema — which the plan-compiler slice supplies — so it is REFUSED
 * (deferred) rather than accepted as free-form text. This keeps a section 10.3
 * absolute path, shell string, or expression from being representable as a pack
 * constant, since a string cannot pass. (Caller-supplied input VALUES use
 * `inputScalar` and remain string-capable — those are runtime data, not pack
 * content, and are bounded against their declared field kind.)
 */
export function boundedScalar(value: unknown, label: string): number | boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumberValue(value, label);
  if (typeof value === "string") {
    throw new PackDeferredError(
      `${label}: a pack-authored string constant is validated against the owning schema in the compiler slice (deferred)`);
  }
  throw new PackParseError(`${label} must be a boolean or finite-number constant`);
}

/**
 * Parse one INTENT-MAPPING constant: a boolean, a finite number, or — unlike
 * every other pack-authored constant — a bounded string.
 *
 * THE STRING ARM IS A DELIBERATE RELAXATION of the boundedScalar refusal, scoped
 * to intent field mappings alone. A real pack must pin values like
 * `relationType: "cites"` as pack content; the refusal that kept strings out of
 * rule parameters stays in force there, but an intent constant lands in a
 * mutation PAYLOAD that is content-addressed at draft time and reviewed before
 * any apply, and the active program direction deprioritizes anti-smuggling
 * hardening — so the honest bound here is the same content rule every
 * pack-authored string carries (control-free per {@link FORBIDDEN_PACK_TEXT_CONTROL},
 * byte-capped), not a ban.
 */
export function intentConstantScalar(value: unknown, label: string): string | number | boolean {
  if (typeof value === "string") {
    if (value.length === 0 || FORBIDDEN_PACK_TEXT_CONTROL.test(value)
      || Buffer.byteLength(value, "utf8") > MAX_DEFAULT_STRING_BYTES) {
      throw new PackParseError(`${label} must be a bounded string without control characters`);
    }
    return value;
  }
  return boundedScalar(value, label);
}

/** Parse one concrete input scalar (string, finite number, or boolean). */
function inputScalar(value: unknown, label: string): PackActionInputScalarV2 {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return finiteNumberValue(value, label);
  if (typeof value === "string" && !hasControlChar(value)
    && Buffer.byteLength(value, "utf8") <= MAX_DEFAULT_STRING_BYTES) {
    return value;
  }
  throw new PackParseError(`${label} must be a bounded scalar value`);
}

/**
 * Parse one concrete input value: a bounded scalar or a bounded list of scalars
 * (section 14.2 default / 19.1 alias default). Schema conformance is checked by
 * the deferred input resolver, so only the value's structural form is bound here.
 */
export function inputValue(value: unknown, label: string): PackActionInputValueV2 {
  if (Array.isArray(value)) {
    return array(value, label, MAX_DEFAULT_VALUE_ITEMS)
      .map((item, index) => inputScalar(item, `${label}[${index}]`));
  }
  return inputScalar(value, label);
}
