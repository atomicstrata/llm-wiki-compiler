/**
 * @file src/operations-packs/parse-input-default.ts
 * @description Validates one input field's declared `default` (and list defaults)
 * through the SAME kind + bounds validator a caller-supplied value of that field
 * would pass (design section 14.2: "Defaults must pass the same validator as
 * caller values"). Without this, a `string` field with maxBytes 1 and a long
 * default, an out-of-range `integer` default, or an `enum` default outside the set
 * would parse — the structural scalar reader alone does not apply the field's kind.
 * Validation is dispatched through one flat table keyed by kind (low complexity),
 * and it fails closed by throwing {@link PackParseError} on any violation.
 */

import { Buffer } from "node:buffer";
import { MAX_DEFAULT_VALUE_ITEMS } from "./constants.js";
import { PackParseError } from "./problems.js";
import type { PackActionInputKindV2, PackActionInputValueV2 } from "./types.js";

/** Require the default to be a single scalar (not a list) before a bound check. */
function requireScalar(value: PackActionInputValueV2, label: string): string | number | boolean {
  if (Array.isArray(value)) throw new PackParseError(`${label} must be a single value`);
  return value as string | number | boolean;
}

/** Validate a scalar string default within a byte ceiling. */
function checkString(value: PackActionInputValueV2, maxBytes: number, label: string): void {
  const scalar = requireScalar(value, label);
  if (typeof scalar !== "string" || Buffer.byteLength(scalar, "utf8") > maxBytes) {
    throw new PackParseError(`${label} must be a string within ${maxBytes} bytes`);
  }
}

/** Validate a list-of-strings default within item and per-item byte ceilings. */
function checkStringList(value: PackActionInputValueV2, maxItems: number, maxItemBytes: number, label: string): void {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new PackParseError(`${label} must be a list within ${maxItems} items`);
  }
  value.forEach((item, index) => checkString(item, maxItemBytes, `${label}[${index}]`));
}

/** Validate a numeric default within an inclusive range, requiring finiteness. */
function checkNumber(value: PackActionInputValueV2, minimum: number, maximum: number, integer: boolean, label: string): void {
  const scalar = requireScalar(value, label);
  const valid = typeof scalar === "number" && (integer ? Number.isSafeInteger(scalar) : Number.isFinite(scalar));
  if (!valid || (scalar as number) < minimum || (scalar as number) > maximum) {
    throw new PackParseError(`${label} must be within [${minimum}, ${maximum}]`);
  }
}

/** Validate a boolean default. */
function checkBoolean(value: PackActionInputValueV2, label: string): void {
  if (typeof requireScalar(value, label) !== "boolean") throw new PackParseError(`${label} must be boolean`);
}

/** Validate an enum default is a member of the closed value set. */
function checkEnum(value: PackActionInputValueV2, values: readonly string[], label: string): void {
  const scalar = requireScalar(value, label);
  if (typeof scalar !== "string" || !values.includes(scalar)) throw new PackParseError(`${label} is not in the enum set`);
}

/** Validate a reference-kind default is a single bounded string identity. */
function checkRefDefault(value: PackActionInputValueV2, label: string): void {
  if (typeof requireScalar(value, label) !== "string") throw new PackParseError(`${label} must be a reference string`);
}

/**
 * The flat per-kind default validator table. A reference kind (entity/artifact/
 * source/caller-file/provider-role/output-format) only checks that the default is
 * a bounded string identity; the resolver binds it to live authority (14.3).
 */
const DEFAULT_VALIDATORS: Readonly<Record<PackActionInputKindV2["kind"], (kind: PackActionInputKindV2, value: PackActionInputValueV2, label: string) => void>> = {
  string: (kind, value, label) => checkString(value, (kind as { maxBytes: number }).maxBytes, label),
  "string-list": (kind, value, label) => checkStringList(value, (kind as { maxItems: number }).maxItems, (kind as { maxItemBytes: number }).maxItemBytes, label),
  boolean: (_kind, value, label) => checkBoolean(value, label),
  integer: (kind, value, label) => checkNumber(value, (kind as { minimum: number }).minimum, (kind as { maximum: number }).maximum, true, label),
  number: (kind, value, label) => checkNumber(value, (kind as { minimum: number }).minimum, (kind as { maximum: number }).maximum, false, label),
  enum: (kind, value, label) => checkEnum(value, (kind as { values: string[] }).values, label),
  "entity-ref": (_kind, value, label) => checkRefDefault(value, label),
  "artifact-ref": (_kind, value, label) => checkRefDefault(value, label),
  "source-ref": (_kind, value, label) => checkRefDefault(value, label),
  "caller-file": (_kind, value, label) => checkRefDefault(value, label),
  uri: (kind, value, label) => checkString(value, (kind as { maxBytes: number }).maxBytes, label),
  "provider-role": (_kind, value, label) => checkRefDefault(value, label),
  "output-format": (_kind, value, label) => checkRefDefault(value, label),
};

/** Validate a field's declared default against its own kind + bounds (14.2). */
export function validateInputDefault(kind: PackActionInputKindV2, value: PackActionInputValueV2, label: string): void {
  if (Array.isArray(value) && value.length > MAX_DEFAULT_VALUE_ITEMS) {
    throw new PackParseError(`${label} exceeds its item cap`);
  }
  DEFAULT_VALIDATORS[kind.kind](kind, value, label);
}
