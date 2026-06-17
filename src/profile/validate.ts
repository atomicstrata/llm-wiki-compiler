/**
 * Fail-closed v0 profile validator.
 *
 * `validateProfile` is the single enforcing gate between an untrusted raw
 * profile object and a typed `ProfilePack`. It is all-or-nothing: ANY
 * structural violation throws `ProfileValidationError` and nothing is
 * returned. The complementary JSON Schema at
 * `./schema/profile.v1.schema.json` (draft 2020-12) is the canonical
 * AUTHORING schema — it documents the v0 shape for editors and tooling — but
 * this function, not the schema, is the runtime enforcer.
 *
 * v0 scope, fail-closed by design:
 *  - schemaVersion must be exactly 1;
 *  - profile inheritance (`extends`) is rejected, not silently ignored;
 *  - reserved profile ids are refused unless the profile IS the built-in default;
 *  - every entity directory is structurally validated and must be unique;
 *  - field types are restricted to the v0 allowlist and numeric defaults must
 *    be finite (NaN/Infinity rejected; finite decimals allowed);
 *  - any declared lifecycle must be a well-formed FSM (see validateLifecycle).
 * Unreachable lifecycle states are collected as warnings, not errors.
 */

import type { ProfilePack, EntityTypeDef, FieldDef, FieldType, LifecycleDef } from "./types.js";
import { isSlugSafe } from "./identity.js";
import { isDefaultProfile } from "./default.js";
import { validateEntityDirectory } from "./paths.js";
import { SOURCES_DIR, LLMWIKI_DIR, EXPORT_DIR } from "../utils/constants.js";

/** The schema version this validator enforces. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** The v0 field-type allowlist. */
const ALLOWED_FIELD_TYPES = new Set<FieldType>([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "slug",
  "enum",
  "string[]",
]);

/** Profile ids reserved by the system; only the built-in default may use one. */
const RESERVED_PROFILE_IDS = new Set(["default"]);

/** Repo-relative roots an entity directory may not overlap. */
const RESERVED_ROOTS = [
  SOURCES_DIR,
  LLMWIKI_DIR,
  ".git",
  "node_modules",
  "dist",
  EXPORT_DIR,
  "wiki/graph",
];

/** The result of a successful validation: the typed pack plus any warnings. */
export interface ProfileValidationResult {
  profile: ProfilePack;
  warnings: string[];
}

/** Error raised when a raw profile violates any v0 invariant. */
export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

/** Throw a ProfileValidationError unless `condition` holds. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProfileValidationError(message);
}

/** True for a non-null plain object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `schemaVersion`, `extends` (fail-closed: inheritance unsupported),
 * and `profileId` (slug-safe, and reserved only for the built-in default).
 */
function validateHeader(raw: Record<string, unknown>): void {
  assert(raw.schemaVersion === SUPPORTED_SCHEMA_VERSION, `unsupported schemaVersion (expected ${SUPPORTED_SCHEMA_VERSION})`);
  const ext = raw.extends;
  assert(ext === undefined || Array.isArray(ext), "extends must be an array when present");
  assert(!Array.isArray(ext) || ext.length === 0, "profile inheritance (extends) is not supported in this release");
  const profileId = raw.profileId;
  assert(typeof profileId === "string" && isSlugSafe(profileId), "profileId must be a slug-safe string");
  const isDefault = isDefaultProfile(raw as unknown as ProfilePack);
  assert(!RESERVED_PROFILE_IDS.has(profileId) || isDefault, `profileId '${profileId}' is reserved`);
}

/** Validate one field definition: type in the allowlist, defaults finite. */
function validateField(name: string, field: FieldDef): void {
  assert(ALLOWED_FIELD_TYPES.has(field.type), `field '${name}' has unsupported type '${field.type}'`);
  if ((field.type === "number" || field.type === "integer") && typeof field.default === "number") {
    assert(Number.isFinite(field.default), `field '${name}' has a non-finite numeric default`);
  }
}

/** Validate every field definition declared on an entity type. */
function validateFields(entityType: string, fields: Record<string, FieldDef> | undefined): void {
  if (!fields) return;
  for (const [name, field] of Object.entries(fields)) {
    assert(isRecord(field), `entity '${entityType}' field '${name}' must be an object`);
    validateField(`${entityType}.${name}`, field);
  }
}

/**
 * Validate a lifecycle FSM and return any unreachable states as warnings.
 *
 * Well-formedness (all throw on violation): the state set is the union of the
 * terminal states and every transition endpoint; initial ∈ states; terminal ⊆
 * states; terminal states have no outgoing transitions; every transition
 * endpoint ∈ states; every transitionRequirements key ∈ states; and if the
 * lifecycle `field` maps to a declared field, that field must be an enum whose
 * values equal the state set. Unreachable states (no path from initial) are
 * returned, not thrown.
 */
function validateLifecycle(entityType: string, lc: LifecycleDef, fields?: Record<string, FieldDef>): string[] {
  const where = `entity '${entityType}' lifecycle`;
  const states = new Set<string>(lc.terminal);
  for (const [from, tos] of Object.entries(lc.transitions)) {
    states.add(from);
    for (const to of tos) states.add(to);
  }
  assert(states.has(lc.initial), `${where}: initial state '${lc.initial}' is not in the state set`);
  for (const t of lc.terminal) {
    assert(states.has(t), `${where}: terminal state '${t}' is not in the state set`);
    assert(!(lc.transitions[t]?.length), `${where}: terminal state '${t}' has outgoing transitions`);
  }
  for (const key of Object.keys(lc.transitionRequirements ?? {})) {
    assert(states.has(key), `${where}: transitionRequirements references unknown state '${key}'`);
  }
  assertLifecycleEnum(where, lc, states, fields);
  return unreachableStates(lc, states).map((s) => `${where}: state '${s}' is unreachable from initial`);
}

/** If the lifecycle field maps to a declared field, it must be an enum = state set. */
function assertLifecycleEnum(where: string, lc: LifecycleDef, states: Set<string>, fields?: Record<string, FieldDef>): void {
  const field = fields?.[lc.field];
  if (!field) return;
  assert(field.type === "enum", `${where}: field '${lc.field}' must be an enum`);
  const values = new Set(field.enum ?? []);
  const sameSize = values.size === states.size;
  const covers = [...states].every((s) => values.has(s));
  assert(sameSize && covers, `${where}: enum values of '${lc.field}' must equal the lifecycle state set`);
}

/** Collect states with no path from `initial` via the transition graph. */
function unreachableStates(lc: LifecycleDef, states: Set<string>): string[] {
  const reached = new Set<string>([lc.initial]);
  const queue = [lc.initial];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const next of lc.transitions[current] ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return [...states].filter((s) => !reached.has(s));
}

/** Validate one entity type's directory, fields, and lifecycle. */
function validateEntity(entityType: string, def: EntityTypeDef): string[] {
  assert(isRecord(def), `entity '${entityType}' must be an object`);
  assert(typeof def.directory === "string", `entity '${entityType}' is missing a directory`);
  validateEntityDirectory(def.directory, RESERVED_ROOTS);
  validateFields(entityType, def.fields);
  return def.lifecycle ? validateLifecycle(entityType, def.lifecycle, def.fields) : [];
}

/** Validate all entities, enforcing directory uniqueness, returning warnings. */
function validateEntities(entities: Record<string, EntityTypeDef>): string[] {
  assert(Object.keys(entities).length > 0, "profile must declare at least one entity");
  const warnings: string[] = [];
  const dirs = new Map<string, string>();
  for (const [entityType, def] of Object.entries(entities)) {
    warnings.push(...validateEntity(entityType, def));
    const prior = dirs.get(def.directory);
    assert(prior === undefined, `entities '${prior}' and '${entityType}' share the same directory '${def.directory}'`);
    dirs.set(def.directory, entityType);
  }
  return warnings;
}

/**
 * Validate a raw, untrusted profile object into a typed `ProfilePack`.
 *
 * Fail-closed and all-or-nothing: throws `ProfileValidationError` on the first
 * violation and returns the validated pack with any (non-fatal) warnings
 * otherwise. The canonical authoring schema is
 * `./schema/profile.v1.schema.json`; this function is the runtime enforcer.
 */
export function validateProfile(raw: unknown): ProfileValidationResult {
  assert(isRecord(raw), "profile must be an object");
  validateHeader(raw);
  assert(isRecord(raw.entities), "profile must declare an 'entities' object");
  const warnings = validateEntities(raw.entities as Record<string, EntityTypeDef>);
  return { profile: raw as unknown as ProfilePack, warnings };
}
