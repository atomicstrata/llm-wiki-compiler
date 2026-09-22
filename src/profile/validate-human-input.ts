/**
 * @file src/profile/validate-human-input.ts
 * @description Semantic validation for the closed human-input descriptor. It
 * rejects unusable bounds and cross-references at profile load, before any run
 * can park on an input contract that core cannot safely enforce.
 */

import { Buffer } from "node:buffer";
import { assert, lifecycleStates } from "./validate-helpers.js";
import { isSlugSafe } from "./identity.js";
import type { EntityTypeDef, HumanInputDescriptorV1, HumanInputFieldV1 } from "./types.js";

const MAX_HUMAN_INPUT_FIELDS = 32;
const MAX_HUMAN_INPUT_LIST_ITEMS = 64;
const MAX_HUMAN_INPUT_VALUE_BYTES = 65_536;
const SCHEMA_ID = /^[a-z0-9][a-z0-9./-]{0,127}$/;
const INPUT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Assert an array is non-empty, unique, and contains only declared ids. */
function assertDeclaredList(values: string[], declared: Set<string>, where: string): void {
  assert(values.length > 0 && values.length <= MAX_HUMAN_INPUT_LIST_ITEMS, `${where} must have 1..${MAX_HUMAN_INPUT_LIST_ITEMS} entries`);
  assert(new Set(values).size === values.length, `${where} entries must be unique`);
  for (const value of values) assert(isSlugSafe(value) && declared.has(value), `${where} contains undeclared id '${value}'`);
}

/** Assert a bounded non-empty unique string set without imposing id grammar. */
function assertValueList(values: string[], where: string): void {
  assert(Array.isArray(values), `${where} must be an array`);
  assert(values.length > 0 && values.length <= MAX_HUMAN_INPUT_LIST_ITEMS, `${where} must have 1..${MAX_HUMAN_INPUT_LIST_ITEMS} entries`);
  assert(new Set(values).size === values.length, `${where} entries must be unique`);
  for (const value of values) {
    assert(typeof value === "string" && Buffer.byteLength(value) <= MAX_HUMAN_INPUT_VALUE_BYTES, `${where} entries must be bounded strings`);
  }
}

/** Assert the field carries exactly the keys its discriminant permits. */
function assertFieldKeys(field: HumanInputFieldV1, where: string): void {
  const common = ["default", "kind", "required"];
  const byKind: Record<HumanInputFieldV1["kind"], string[]> = {
    string: ["maxBytes", "nullable"], enum: ["values"],
    "entity-ref": ["allowedInput", "entityTypes", "lifecycleStates"],
    "artifact-ref": ["allowedInput", "artifactTypes"],
    "string-list": ["maxItemBytes", "maxItems"],
    "ref-list": ["allowedInput", "artifactTypes", "entityTypes", "lifecycleStates", "maxItems", "referenceKind"],
  };
  const allowed = new Set([...common, ...byKind[field.kind]]);
  assert(Object.keys(field).every((key) => allowed.has(key)), `${where} carries a key not allowed for kind '${field.kind}'`);
}

/** Assert one positive integer bound does not exceed the hard ceiling. */
function assertBound(value: number, max: number, where: string): void {
  assert(Number.isSafeInteger(value) && value >= 1 && value <= max, `${where} must be an integer in 1..${max}`);
}

/** Validate lifecycle filters against every admitted entity type. */
function assertLifecycleStates(
  field: { entityTypes?: string[]; lifecycleStates?: string[] }, entities: Record<string, EntityTypeDef>, where: string,
): void {
  if (field.lifecycleStates === undefined) return;
  assert(field.lifecycleStates.length > 0, `${where}.lifecycleStates must not be empty`);
  for (const type of field.entityTypes ?? []) {
    const lifecycle = entities[type]?.lifecycle;
    assert(lifecycle !== undefined, `${where} lifecycle filter requires '${type}' to declare a lifecycle`);
    const states = lifecycleStates(lifecycle!);
    for (const state of field.lifecycleStates) assert(states.has(state), `${where} names undeclared lifecycle state '${state}' for '${type}'`);
  }
}

/** Validate a present default against a predicate. */
function assertDefault(field: HumanInputFieldV1, valid: (value: unknown) => boolean, where: string): void {
  if (field.default !== undefined) assert(valid(field.default), `${where}.default does not satisfy its field contract`);
}

/** Validate one string field. */
function validateString(field: Extract<HumanInputFieldV1, { kind: "string" }>, where: string): void {
  assertBound(field.maxBytes, MAX_HUMAN_INPUT_VALUE_BYTES, `${where}.maxBytes`);
  assertDefault(field, (value) => (typeof value === "string" && Buffer.byteLength(value) <= field.maxBytes)
    || (value === null && field.nullable === true), where);
}

/** Validate one enum field. */
function validateEnum(field: Extract<HumanInputFieldV1, { kind: "enum" }>, where: string): void {
  assertValueList(field.values, `${where}.values`);
  assertDefault(field, (value) => typeof value === "string" && field.values.includes(value), where);
}

/** Validate one bounded string-list field. */
function validateStringList(field: Extract<HumanInputFieldV1, { kind: "string-list" }>, where: string): void {
  assertBound(field.maxItems, MAX_HUMAN_INPUT_LIST_ITEMS, `${where}.maxItems`);
  assertBound(field.maxItemBytes, MAX_HUMAN_INPUT_VALUE_BYTES, `${where}.maxItemBytes`);
  assertDefault(field, (value) => Array.isArray(value) && value.length <= field.maxItems
    && value.every((item) => Buffer.byteLength(item) <= field.maxItemBytes), where);
}

/** Validate one scalar reference declaration. */
function validateScalarRef(
  field: Extract<HumanInputFieldV1, { kind: "entity-ref" | "artifact-ref" }>,
  entities: Record<string, EntityTypeDef>, artifacts: Set<string>, where: string,
): void {
  const declared = field.kind === "entity-ref" ? new Set(Object.keys(entities)) : artifacts;
  const values = field.kind === "entity-ref" ? field.entityTypes : field.artifactTypes;
  assertDeclaredList(values, declared, `${where}.${field.kind === "entity-ref" ? "entityTypes" : "artifactTypes"}`);
  assertDefault(field, (value) => typeof value === "string", where);
}

/** Validate one field's common and kind-specific declaration. */
function validateFieldKind(
  field: HumanInputFieldV1, entities: Record<string, EntityTypeDef>, artifacts: Set<string>, where: string,
): void {
  if (field.kind === "string") validateString(field, where);
  else if (field.kind === "enum") validateEnum(field, where);
  else if (field.kind === "string-list") validateStringList(field, where);
  else if (field.kind === "ref-list") validateRefList(field, entities, artifacts, where);
  else validateScalarRef(field, entities, artifacts, where);
}

/** Validate an optional run-input subset binding name. */
function validateAllowedInput(field: HumanInputFieldV1, where: string): void {
  if ("allowedInput" in field && field.allowedInput !== undefined) assert(INPUT_KEY.test(field.allowedInput), `${where}.allowedInput is malformed`);
}

/** Validate lifecycle filters only for entity-bearing field kinds. */
function validateFieldLifecycle(field: HumanInputFieldV1, entities: Record<string, EntityTypeDef>, where: string): void {
  if (field.kind === "entity-ref" || (field.kind === "ref-list" && field.referenceKind === "entity")) assertLifecycleStates(field, entities, where);
}

/** Validate one field's common and kind-specific declaration. */
function validateField(
  field: HumanInputFieldV1, entities: Record<string, EntityTypeDef>, artifacts: Set<string>, where: string,
): void {
  assertFieldKeys(field, where);
  validateFieldKind(field, entities, artifacts, where);
  validateAllowedInput(field, where);
  validateFieldLifecycle(field, entities, where);
}

/** Validate the entity/artifact arm of a reference list. */
function validateRefList(
  field: Extract<HumanInputFieldV1, { kind: "ref-list" }>,
  entities: Record<string, EntityTypeDef>, artifacts: Set<string>, where: string,
): void {
  assertBound(field.maxItems, MAX_HUMAN_INPUT_LIST_ITEMS, `${where}.maxItems`);
  if (field.referenceKind === "entity") {
    assert(field.artifactTypes === undefined, `${where} entity refs cannot declare artifactTypes`);
    assertDeclaredList(field.entityTypes ?? [], new Set(Object.keys(entities)), `${where}.entityTypes`);
    assertDefault(field, (value) => Array.isArray(value) && value.length <= field.maxItems, where);
    return;
  }
  assert(field.entityTypes === undefined && field.lifecycleStates === undefined, `${where} artifact refs cannot declare entity constraints`);
  assertDeclaredList(field.artifactTypes ?? [], artifacts, `${where}.artifactTypes`);
  assertDefault(field, (value) => Array.isArray(value) && value.length <= field.maxItems, where);
}

/** Validate a complete human-input descriptor at profile load. */
export function validateHumanInputDescriptor(
  descriptor: HumanInputDescriptorV1 | undefined,
  entities: Record<string, EntityTypeDef>, artifacts: Set<string>, where: string,
): void {
  if (descriptor === undefined) return;
  assert(SCHEMA_ID.test(descriptor.schemaId), `${where}.schemaId is malformed`);
  const entries = Object.entries(descriptor.fields);
  assert(entries.length <= MAX_HUMAN_INPUT_FIELDS, `${where}.fields exceeds ${MAX_HUMAN_INPUT_FIELDS}`);
  for (const [name, field] of entries) {
    assert(INPUT_KEY.test(name), `${where}.fields key '${name}' is malformed`);
    validateField(field, entities, artifacts, `${where}.fields.${name}`);
  }
}
