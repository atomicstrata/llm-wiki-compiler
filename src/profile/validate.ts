/**
 * Fail-closed v0 profile validator — schema-first, two-phase.
 *
 * `validateProfile` is the single enforcing gate between an untrusted raw
 * profile object and a typed `ProfilePack`. It is all-or-nothing: ANY violation
 * throws `ProfileValidationError` and nothing is returned.
 *
 * Validation runs in two phases:
 *  1. STRUCTURAL (ajv): the published JSON Schema at
 *     `./schema/profile.v1.schema.json` (draft 2020-12) is the runtime enforcer
 *     for structure, types, enums, and `additionalProperties` — compiled once in
 *     `schema-validator.ts`. The schema is the single source of truth here; the
 *     hand validator used to drift from it, so that responsibility now lives in
 *     the schema.
 *  2. SEMANTIC (post-ajv): the checks JSON Schema cannot express — directory
 *     canonicalization + uniqueness + reserved-root confinement, requiredFields
 *     references, lifecycle FSM well-formedness, slug-safe entity-type keys,
 *     defensive non-finite-number rejection, the unsupported `extends`
 *     inheritance, and (in `validateProfile` only) reserved profile ids.
 *
 * Validation NEVER mutates the caller's input: the raw object is cloned up
 * front and only the clone is canonicalized and returned. `validateProfileShape`
 * runs both phases EXCEPT the reserved-id rejection, so the built-in default
 * profile (`profileId: "default"`) can be proven to satisfy the same structural
 * contract that disk profiles claiming `"default"` are rejected against.
 * Unreachable lifecycle states are collected as warnings, not errors.
 */

import type { ProfilePack, EntityTypeDef, FieldDef, LifecycleDef } from "./types.js";
import { isSlugSafe } from "./identity.js";
import { validateEntityDirectory } from "./paths.js";
import { assertStructurallyValid } from "./schema-validator.js";
import { ProfileValidationError } from "./errors.js";
import { SOURCES_DIR, LLMWIKI_DIR, EXPORT_DIR, CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";

export { ProfileValidationError } from "./errors.js";

/**
 * Profile ids reserved by the system. `default` names the in-memory built-in
 * profile, which never loads from disk through `validateProfile` — so a disk
 * profile claiming it is always rejected. `validateProfileShape` skips this gate
 * so the built-in default can be proven structurally well-formed.
 */
const RESERVED_PROFILE_IDS = new Set(["default"]);

/**
 * Entity directories reserved for the built-in DEFAULT profile. A disk profile
 * may not declare an entity at either, otherwise one physical file would carry
 * two identities — a legacy `pages: concepts/<slug>` AND a
 * `profile.entityPages: <type>/<slug>`. `DEFAULT_PROFILE` legitimately uses
 * these, so this gate lives in `validateProfile` (disk) only, NOT
 * `validateProfileShape`.
 */
const RESERVED_DEFAULT_DIRS = new Set([CONCEPTS_DIR, QUERIES_DIR]);

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

/** Throw a ProfileValidationError unless `condition` holds. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProfileValidationError(message);
}

/**
 * Reject the unsupported `extends` inheritance with a clear message. ajv already
 * rejects a non-empty `extends` via `maxItems: 0`, but the semantic message
 * names inheritance explicitly (the schema's wording is generic).
 */
function rejectInheritance(raw: ProfilePack): void {
  const ext = raw.extends;
  assert(
    ext === undefined || ext.length === 0,
    "profile inheritance (extends) is not supported in this release",
  );
}

/** Reject any non-finite numeric field-def or retrieval value defensively. */
function assertFiniteNumbers(entityType: string, def: EntityTypeDef): void {
  for (const [name, field] of Object.entries(def.fields ?? {})) {
    for (const key of ["default", "min", "max"] as const) {
      const value = field[key];
      if (typeof value === "number") {
        assert(Number.isFinite(value), `entity '${entityType}' field '${name}' has a non-finite ${key}`);
      }
    }
  }
  const weight = def.retrieval?.defaultWeight;
  if (typeof weight === "number") {
    assert(Number.isFinite(weight), `entity '${entityType}' retrieval.defaultWeight must be finite`);
  }
}

/** Every requiredFields entry must reference a declared field. */
function validateRequiredFields(entityType: string, def: EntityTypeDef): void {
  for (const name of def.requiredFields ?? []) {
    assert(def.fields?.[name] !== undefined, `entity '${entityType}' requiredFields entry '${name}' is not a declared field`);
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
 * values equal the state set. Unreachable states are returned, not thrown.
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
 * Validate one entity type's SEMANTICS (structure is already ajv-checked).
 * Canonicalizes and confines its directory (returning the canonical form), and
 * validates finite numbers, requiredFields references, and lifecycle.
 */
function validateEntity(entityType: string, def: EntityTypeDef): EntityValidation {
  const canonicalDirectory = validateEntityDirectory(def.directory, RESERVED_ROOTS);
  assertFiniteNumbers(entityType, def);
  validateRequiredFields(entityType, def);
  const warnings = def.lifecycle ? validateLifecycle(entityType, def.lifecycle, def.fields) : [];
  return { canonicalDirectory, warnings };
}

/**
 * Validate all entities, enforcing slug-safe type keys and CANONICAL directory
 * uniqueness, writing each canonical directory back ON THE CLONE so downstream
 * scanning uses the same path uniqueness was checked against. Returns warnings.
 */
function validateEntities(entities: Record<string, EntityTypeDef>): string[] {
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
 * Validate a raw profile's SHAPE: the ajv structural gate plus every semantic
 * check, EXCEPT the reserved profileId rejection. The built-in default profile
 * passes this; disk profiles claiming `"default"` are still rejected by
 * `validateProfile`. Non-mutating: clones the input and returns the canonical
 * clone.
 */
export function validateProfileShape(raw: unknown): ProfileValidationResult {
  assertStructurallyValid(raw);
  const profile = structuredClone(raw) as ProfilePack;
  rejectInheritance(profile);
  const warnings = validateEntities(profile.entities);
  return { profile, warnings };
}

/**
 * Validate a raw, untrusted profile object into a typed `ProfilePack`.
 *
 * Two-phase and fail-closed: the ajv schema gate runs first, then the semantic
 * checks. Adds the disk-only reserved-id rejection on top of
 * `validateProfileShape`. Never mutates the caller's input; returns the
 * canonical clone with any (non-fatal) warnings.
 */
export function validateProfile(raw: unknown): ProfileValidationResult {
  const result = validateProfileShape(raw);
  assert(!RESERVED_PROFILE_IDS.has(result.profile.profileId), `profileId '${result.profile.profileId}' is reserved`);
  rejectReservedDefaultDirs(result.profile);
  return result;
}

/**
 * Reject any entity whose canonical directory is one of the default profile's
 * reserved dirs (`wiki/concepts` / `wiki/queries`). Operates on the canonical
 * directory written back by {@link validateProfileShape}, so `.`-padded aliases
 * are caught too.
 */
function rejectReservedDefaultDirs(profile: ProfilePack): void {
  for (const [entityType, def] of Object.entries(profile.entities)) {
    assert(
      !RESERVED_DEFAULT_DIRS.has(def.directory),
      `entity '${entityType}' directory '${def.directory}' is reserved for the default profile`,
    );
  }
}
