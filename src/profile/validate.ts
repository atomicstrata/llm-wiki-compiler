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

/**
 * Profile ids reserved by the system. `default` names the in-memory built-in
 * profile, which never loads from disk through this validator — so a disk
 * profile claiming it is always rejected (no exception).
 */
const RESERVED_PROFILE_IDS = new Set(["default"]);

/** Allowed keys at each level — anything else is rejected (schema-parity). */
const ALLOWED_TOP_KEYS = new Set([
  "schemaVersion", "profileId", "profileVersion", "displayName", "extends", "entities",
]);
const ALLOWED_ENTITY_KEYS = new Set([
  "directory", "titleField", "requiredFields", "fields", "retrieval", "lifecycle", "export",
]);
const ALLOWED_FIELD_KEYS = new Set(["type", "required", "default", "enum", "min", "max"]);
const ALLOWED_READ_EXPOSURE = new Set(["agent-readable", "local-only"]);

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

/** Reject any key of `obj` not present in `allowed` (allowlist, fail-closed). */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    assert(allowed.has(key), `${where}: unknown key '${key}'`);
  }
}

/**
 * Validate the top-level header: only allowlisted keys, `schemaVersion`,
 * `extends` (fail-closed — inheritance unsupported), and `profileId` (slug-safe
 * and NOT a reserved id; `default` is reserved for the in-memory built-in,
 * which never loads through this validator).
 */
function validateHeader(raw: Record<string, unknown>): void {
  rejectUnknownKeys(raw, ALLOWED_TOP_KEYS, "profile");
  assert(raw.schemaVersion === SUPPORTED_SCHEMA_VERSION, `unsupported schemaVersion (expected ${SUPPORTED_SCHEMA_VERSION})`);
  const ext = raw.extends;
  assert(ext === undefined || Array.isArray(ext), "extends must be an array when present");
  assert(!Array.isArray(ext) || ext.length === 0, "profile inheritance (extends) is not supported in this release");
  const profileId = raw.profileId;
  assert(typeof profileId === "string" && isSlugSafe(profileId), "profileId must be a slug-safe string");
  assert(!RESERVED_PROFILE_IDS.has(profileId), `profileId '${profileId}' is reserved`);
}

/** Assert that the named numeric field-def value, when present, is finite. */
function assertFiniteNumber(name: string, key: string, value: unknown): void {
  if (typeof value === "number") {
    assert(Number.isFinite(value), `field '${name}' has a non-finite ${key}`);
  }
}

/**
 * Validate one field definition: only allowlisted keys, a type in the v0
 * allowlist, finite numeric `default`/`min`/`max`, and a string[] `enum`.
 */
function validateField(name: string, field: Record<string, unknown>): void {
  rejectUnknownKeys(field, ALLOWED_FIELD_KEYS, `field '${name}'`);
  assert(ALLOWED_FIELD_TYPES.has(field.type as FieldType), `field '${name}' has unsupported type '${field.type}'`);
  assertFiniteNumber(name, "default", field.default);
  assertFiniteNumber(name, "min", field.min);
  assertFiniteNumber(name, "max", field.max);
  if (field.enum !== undefined) {
    assert(Array.isArray(field.enum) && field.enum.every((v) => typeof v === "string"), `field '${name}' enum must be a string[]`);
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

/** Validate a retrieval block: object, readExposure in the set, finite weight. */
function validateRetrieval(entityType: string, retrieval: unknown): void {
  const where = `entity '${entityType}' retrieval`;
  assert(isRecord(retrieval), `${where} must be an object`);
  const { readExposure, defaultWeight } = retrieval;
  if (readExposure !== undefined) {
    assert(typeof readExposure === "string" && ALLOWED_READ_EXPOSURE.has(readExposure), `${where}: readExposure '${String(readExposure)}' is not allowed`);
  }
  if (defaultWeight !== undefined) {
    assert(typeof defaultWeight === "number" && Number.isFinite(defaultWeight), `${where}: defaultWeight must be a finite number`);
  }
}

/** Every requiredFields entry must reference a declared field. */
function validateRequiredFields(entityType: string, required: string[] | undefined, fields?: Record<string, FieldDef>): void {
  if (!required) return;
  for (const name of required) {
    assert(fields?.[name] !== undefined, `entity '${entityType}' requiredFields entry '${name}' is not a declared field`);
  }
}

/** Validate the optional export block: only `okfType`, a string when present. */
function validateExport(entityType: string, exp: { okfType?: unknown }): void {
  assert(isRecord(exp), `entity '${entityType}' export must be an object`);
  rejectUnknownKeys(exp, new Set(["okfType"]), `entity '${entityType}' export`);
  if (exp.okfType !== undefined) {
    assert(typeof exp.okfType === "string", `entity '${entityType}' export.okfType must be a string`);
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

/** The result of validating one entity: its canonical dir plus any warnings. */
interface EntityValidation {
  canonicalDirectory: string;
  warnings: string[];
}

/**
 * Validate one entity type. Allowlists its keys, structurally validates the
 * directory (returning the canonical form), and validates fields, retrieval,
 * requiredFields, export, and lifecycle.
 */
function validateEntity(entityType: string, def: EntityTypeDef): EntityValidation {
  assert(isRecord(def), `entity '${entityType}' must be an object`);
  rejectUnknownKeys(def, ALLOWED_ENTITY_KEYS, `entity '${entityType}'`);
  assert(typeof def.directory === "string", `entity '${entityType}' is missing a directory`);
  const canonicalDirectory = validateEntityDirectory(def.directory, RESERVED_ROOTS);
  validateFields(entityType, def.fields);
  if (def.retrieval !== undefined) validateRetrieval(entityType, def.retrieval);
  validateRequiredFields(entityType, def.requiredFields, def.fields);
  if (def.export !== undefined) validateExport(entityType, def.export);
  const warnings = def.lifecycle ? validateLifecycle(entityType, def.lifecycle, def.fields) : [];
  return { canonicalDirectory, warnings };
}

/**
 * Validate all entities, enforcing slug-safe type keys and CANONICAL directory
 * uniqueness, writing each canonical directory back so downstream scanning uses
 * the same path uniqueness was checked against. Returns lifecycle warnings.
 */
function validateEntities(entities: Record<string, EntityTypeDef>): string[] {
  assert(Object.keys(entities).length > 0, "profile must declare at least one entity");
  const warnings: string[] = [];
  const dirs = new Map<string, string>();
  for (const [entityType, def] of Object.entries(entities)) {
    assert(isSlugSafe(entityType), `entity type key '${entityType}' must be slug-safe`);
    const { canonicalDirectory, warnings: entityWarnings } = validateEntity(entityType, def);
    warnings.push(...entityWarnings);
    const prior = dirs.get(canonicalDirectory);
    assert(prior === undefined, `entities '${prior}' and '${entityType}' share the same directory '${canonicalDirectory}'`);
    dirs.set(canonicalDirectory, entityType);
    def.directory = canonicalDirectory;
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
