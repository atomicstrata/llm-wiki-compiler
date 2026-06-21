/**
 * @file src/profile/field-contract.ts
 * @description The single, PURE per-page field-contract validator for a profile
 * entity type — shared by the read-surface collector ({@link collectEntityPages}
 * in `collect.ts`) and the typed WRITE gates (`stageEntityPage`,
 * `applyTypedCandidate`), so both enforce ONE implementation (DRY).
 *
 * Given a page's parsed frontmatter and the resolved {@link EntityTypeDef}, it
 * returns a list of PATH-FREE field-violation messages: one per missing required
 * field, and one per present field value that mismatches its declared type, enum
 * membership, or numeric min/max. It is pure (no I/O), never throws, and carries
 * no path/entity-type context — callers attach that when they wrap each message
 * into their own problem/error shape.
 */

import { isSlugSafe } from "./identity.js";
import type { EntityTypeDef, FieldDef, FieldType } from "./types.js";

/**
 * Thrown by the typed WRITE gates (staging / promotion) when a candidate body's
 * frontmatter violates its entity type's declared field contract — a missing
 * required field, or a type/enum/range mismatch. Fails CLOSED so a contract-
 * violating typed page is never staged or promoted (on the READ surfaces the same
 * violations are non-fatal problems, not throws). Carries the structured list of
 * PATH-FREE violation messages so callers can surface exactly what failed.
 */
export class EntityFieldContractError extends Error {
  /** The PATH-FREE field-violation messages that caused the refusal. */
  readonly violations: string[];

  constructor(entityType: string, slug: string, violations: string[]) {
    super(
      `typed page ${entityType}/${slug} violates the profile field contract: ` +
        `${violations.join(" ")}`,
    );
    this.name = "EntityFieldContractError";
    this.violations = violations;
  }
}

/**
 * Compute the de-duplicated set of required field names for an entity type: the
 * UNION of the entity-level `requiredFields` array and every field whose own
 * `FieldDef.required === true`. Returned as a `Set` so a field declared required
 * BOTH ways yields exactly one missing-field message, never two.
 */
function requiredFieldNames(def: EntityTypeDef): Set<string> {
  const names = new Set<string>(def.requiredFields ?? []);
  for (const [name, fieldDef] of Object.entries(def.fields ?? {})) {
    if (fieldDef.required === true) names.add(name);
  }
  return names;
}

/** True when `value` is a string parseable as a date, or a valid `Date`. */
function isValidDate(value: unknown): boolean {
  // YAML parses an unquoted ISO date into a JS `Date`; a quoted value stays a
  // string. Accept either, provided it denotes a valid instant.
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Per-field-type value predicates (enum excluded — it needs the `FieldDef`).
 * A lookup table keeps {@link matchesDeclaredType} flat instead of a wide switch.
 */
const TYPE_PREDICATES: Record<Exclude<FieldType, "enum">, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  slug: (v) => typeof v === "string" && isSlugSafe(v),
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  date: isValidDate,
  "string[]": (v) => Array.isArray(v) && v.every((item) => typeof item === "string"),
};

/** True when `value` satisfies the declared `FieldDef.type` (enum included). */
function matchesDeclaredType(fieldDef: FieldDef, value: unknown): boolean {
  if (fieldDef.type === "enum") {
    return typeof value === "string" && (fieldDef.enum?.includes(value) ?? false);
  }
  return TYPE_PREDICATES[fieldDef.type](value);
}

/**
 * Return a PATH-FREE message when `value` does not match `fieldDef.type`
 * (including enum membership), or `undefined` when the type is satisfied.
 */
function describeTypeMismatch(name: string, fieldDef: FieldDef, value: unknown): string | undefined {
  if (matchesDeclaredType(fieldDef, value)) return undefined;
  if (fieldDef.type === "enum") {
    return (
      `Field ${JSON.stringify(name)} value ${JSON.stringify(value)} is not one of ` +
      `${JSON.stringify(fieldDef.enum ?? [])}.`
    );
  }
  return `Field ${JSON.stringify(name)} value ${JSON.stringify(value)} is not a valid ${fieldDef.type}.`;
}

/**
 * Return a PATH-FREE message when a numeric `value` falls outside the declared
 * `[min, max]`, or `undefined` when in range or when no bound applies. Only
 * meaningful after the value has passed its numeric type check.
 */
function describeRangeViolation(name: string, fieldDef: FieldDef, value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  if (fieldDef.min !== undefined && value < fieldDef.min) {
    return `Field ${JSON.stringify(name)} value ${value} is below min ${fieldDef.min}.`;
  }
  if (fieldDef.max !== undefined && value > fieldDef.max) {
    return `Field ${JSON.stringify(name)} value ${value} exceeds max ${fieldDef.max}.`;
  }
  return undefined;
}

/** Append every violation message for one present field value to `out`. */
function collectFieldValueViolations(
  name: string,
  fieldDef: FieldDef,
  value: unknown,
  out: string[],
): void {
  if (value === undefined) return; // presence is handled by the required check
  const typeError = describeTypeMismatch(name, fieldDef, value);
  if (typeError) {
    out.push(typeError);
    return;
  }
  const rangeError = describeRangeViolation(name, fieldDef, value);
  if (rangeError) out.push(rangeError);
}

/**
 * Validate a page's parsed frontmatter against its entity type's declared field
 * contract, returning a list of PATH-FREE violation messages (empty when the page
 * satisfies the contract). One message per missing required field, plus one per
 * present field value that mismatches its declared type / enum / numeric bound.
 *
 * A field is required when it appears in `def.requiredFields` OR carries
 * `FieldDef.required === true` (the union, de-duplicated). Pure and total — no
 * I/O, never throws, carries no path/entity-type context.
 *
 * @param frontmatter - The page's parsed frontmatter record.
 * @param def - The resolved entity type definition to validate against.
 * @returns Zero or more PATH-FREE field-violation messages.
 */
export function validateEntityFields(
  frontmatter: Record<string, unknown>,
  def: EntityTypeDef,
): string[] {
  const violations: string[] = [];
  for (const field of requiredFieldNames(def)) {
    if (!(field in frontmatter)) {
      violations.push(`Required field ${JSON.stringify(field)} is missing from frontmatter.`);
    }
  }
  for (const [name, fieldDef] of Object.entries(def.fields ?? {})) {
    collectFieldValueViolations(name, fieldDef, frontmatter[name], violations);
  }
  return violations;
}
