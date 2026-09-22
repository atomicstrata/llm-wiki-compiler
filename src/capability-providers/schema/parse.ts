/**
 * @file src/capability-providers/schema/parse.ts
 * @description Duplicate-key-rejecting parser for the exact Provider V2
 * schema grammar. It rebuilds and freezes allowlisted nodes before branding.
 */
import { MAX_SIGNED_PROVIDER_ENVELOPE_BYTES } from "../constants.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import {
  assertClosedProviderSchemaSemantics,
  CLOSED_PROVIDER_SCHEMA_FORMATS,
  CLOSED_PROVIDER_SCHEMA_PATTERNS,
  MAX_CLOSED_SCHEMA_ARRAY_ITEMS,
  MAX_CLOSED_SCHEMA_DEFINITIONS,
  MAX_CLOSED_SCHEMA_DEPTH,
  MAX_CLOSED_SCHEMA_ENUM_VALUES,
  MAX_CLOSED_SCHEMA_MEMBERS,
  MAX_CLOSED_SCHEMA_PROPERTIES,
  MAX_CLOSED_SCHEMA_STRING_LENGTH,
} from "./types.js";
import type {
  ClosedProviderJsonScalarV1,
  ClosedProviderSchemaNodeV1,
  ClosedProviderSchemaV1,
  ParsedClosedProviderSchemaV1,
} from "./types.js";

const JSON_SCAN_DEPTH = 96;
const MAX_DYNAMIC_KEY_BYTES = 128;
const MAX_UNION_BRANCHES = 32;
const DEFINITION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const parsedSchemas = new WeakSet<object>();

interface ParseContext {
  members: number;
}

/** Parse untrusted JSON into one frozen, branded closed schema. */
export function parseClosedProviderSchema(text: string): ParsedClosedProviderSchemaV1 {
  const raw = parseBoundedUniqueJson(
    text,
    MAX_SIGNED_PROVIDER_ENVELOPE_BYTES,
    JSON_SCAN_DEPTH,
  );
  const schema = parseRoot(raw, { members: 0 });
  assertClosedProviderSchemaSemantics(schema);
  const parsed = Object.freeze({ schema }) as ParsedClosedProviderSchemaV1;
  parsedSchemas.add(parsed);
  return parsed;
}

/** @internal Recover a schema only from an object minted by this parser. */
export function requireParsedClosedProviderSchema(
  parsed: ParsedClosedProviderSchemaV1,
): ClosedProviderSchemaV1 {
  if (!parsedSchemas.has(parsed)) {
    throw new Error("closed provider schema was not produced by the trusted parser");
  }
  return parsed.schema;
}

function parseRoot(value: unknown, context: ParseContext): ClosedProviderSchemaV1 {
  const record = requireRecord(value, "closed provider schema");
  const definitions = parseDefinitions(record.$defs, context);
  const nodeInput = withoutKey(record, "$defs");
  const node = parseNode(nodeInput, context, 0);
  if (!definitions) return node as ClosedProviderSchemaV1;
  return Object.freeze({ ...node, $defs: definitions }) as ClosedProviderSchemaV1;
}

function parseDefinitions(
  value: unknown,
  context: ParseContext,
): Readonly<Record<string, ClosedProviderSchemaNodeV1>> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "$defs");
  const entries = Object.entries(record);
  if (entries.length > MAX_CLOSED_SCHEMA_DEFINITIONS) {
    throw new Error("closed provider schema exceeds its definition cap");
  }
  const definitions = emptyRecord<ClosedProviderSchemaNodeV1>();
  for (const [name, raw] of entries) {
    assertDynamicKey(name, "definition");
    if (!DEFINITION_NAME_PATTERN.test(name)) throw new Error(`invalid definition name: ${name}`);
    definitions[name] = parseNode(raw, context, 1);
  }
  return Object.freeze(definitions);
}

function parseNode(
  value: unknown,
  context: ParseContext,
  depth: number,
): ClosedProviderSchemaNodeV1 {
  countMember(context);
  if (depth > MAX_CLOSED_SCHEMA_DEPTH) throw new Error("closed provider schema exceeds its depth cap");
  const record = requireRecord(value, "schema node");
  assertNoPrototypeKeys(record);
  if (hasOwn(record, "$ref")) return parseReference(record);
  if (hasOwn(record, "oneOf") || hasOwn(record, "discriminator")) {
    return parseUnion(record, context, depth);
  }
  if (hasOwn(record, "enum")) return parseEnum(record);
  if (hasOwn(record, "const")) return parseConst(record);
  return parseTyped(record, context, depth);
}

function parseTyped(
  record: Record<string, unknown>,
  context: ParseContext,
  depth: number,
): ClosedProviderSchemaNodeV1 {
  switch (record.type) {
    case "object": return parseObject(record, context, depth);
    case "array": return parseArray(record, context, depth);
    case "string": return parseString(record);
    case "number": return parseNumber(record, false);
    case "integer": return parseNumber(record, true);
    case "boolean": return parseEmptyTyped(record, "boolean");
    case "null": return parseEmptyTyped(record, "null");
    default: throw new Error("unsupported closed provider schema type");
  }
}

function parseObject(
  record: Record<string, unknown>,
  context: ParseContext,
  depth: number,
): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["type", "properties", "required", "additionalProperties"]);
  if (record.additionalProperties !== false) {
    throw new Error("object schema requires additionalProperties: false");
  }
  const rawProperties = requireRecord(record.properties, "object properties");
  const entries = Object.entries(rawProperties);
  if (entries.length > MAX_CLOSED_SCHEMA_PROPERTIES) {
    throw new Error("closed provider schema exceeds its property cap");
  }
  const properties = emptyRecord<ClosedProviderSchemaNodeV1>();
  for (const [name, raw] of entries) {
    assertDynamicKey(name, "property");
    properties[name] = parseNode(raw, context, depth + 1);
  }
  const required = parseRequired(record.required, properties);
  const result = { type: "object", properties: Object.freeze(properties), additionalProperties: false } as const;
  return Object.freeze(required ? { ...result, required } : result);
}

function parseRequired(
  value: unknown,
  properties: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("object required must be an array");
  const required = value.map((entry) => requireString(entry, "required property"));
  if (new Set(required).size !== required.length) throw new Error("object required contains a duplicate");
  for (const name of required) {
    assertDynamicKey(name, "required property");
    if (!hasOwn(properties, name)) throw new Error(`required property is not declared: ${name}`);
  }
  return Object.freeze(required);
}

function parseArray(
  record: Record<string, unknown>,
  context: ParseContext,
  depth: number,
): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["type", "items", "minItems", "maxItems"]);
  if (!hasOwn(record, "items")) throw new Error("array schema requires items");
  const maximum = boundedInteger(record.maxItems, "maxItems", MAX_CLOSED_SCHEMA_ARRAY_ITEMS);
  const minimum = optionalBoundedInteger(record.minItems, "minItems", maximum);
  const items = parseNode(record.items, context, depth + 1);
  const result = { type: "array", items, maxItems: maximum } as const;
  return Object.freeze(minimum === undefined ? result : { ...result, minItems: minimum });
}

function parseString(record: Record<string, unknown>): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["type", "minLength", "maxLength", "pattern", "format"]);
  const maximum = boundedInteger(record.maxLength, "maxLength", MAX_CLOSED_SCHEMA_STRING_LENGTH);
  const minimum = optionalBoundedInteger(record.minLength, "minLength", maximum);
  const pattern = optionalAllowedString(record.pattern, CLOSED_PROVIDER_SCHEMA_PATTERNS, "pattern");
  const format = optionalAllowedString(record.format, CLOSED_PROVIDER_SCHEMA_FORMATS, "format");
  const result: Record<string, unknown> = { type: "string", maxLength: maximum };
  if (minimum !== undefined) result.minLength = minimum;
  if (pattern !== undefined) result.pattern = pattern;
  if (format !== undefined) result.format = format;
  return Object.freeze(result) as unknown as ClosedProviderSchemaNodeV1;
}

function parseNumber(
  record: Record<string, unknown>,
  integer: boolean,
): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["type", "minimum", "maximum"]);
  const minimum = finiteNumber(record.minimum, "minimum", integer);
  const maximum = finiteNumber(record.maximum, "maximum", integer);
  if (minimum > maximum) throw new Error("numeric schema minimum exceeds maximum");
  return Object.freeze({ type: integer ? "integer" : "number", minimum, maximum });
}

function parseEmptyTyped(
  record: Record<string, unknown>,
  type: "boolean" | "null",
): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["type"]);
  return Object.freeze({ type });
}

function parseReference(record: Record<string, unknown>): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["$ref"]);
  const reference = requireString(record.$ref, "$ref");
  if (!/^#\/\$defs\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(reference)) {
    throw new Error("schema $ref must be a bounded local reference");
  }
  return Object.freeze({ $ref: reference }) as ClosedProviderSchemaNodeV1;
}

function parseUnion(
  record: Record<string, unknown>,
  context: ParseContext,
  depth: number,
): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["oneOf", "discriminator"]);
  if (!Array.isArray(record.oneOf) || record.oneOf.length < 1 || record.oneOf.length > MAX_UNION_BRANCHES) {
    throw new Error("discriminated union oneOf exceeds its branch bounds");
  }
  const discriminator = requireRecord(record.discriminator, "discriminator");
  assertExactKeys(discriminator, ["propertyName"]);
  const propertyName = requireString(discriminator.propertyName, "discriminator propertyName");
  assertDynamicKey(propertyName, "discriminator property");
  const oneOf = record.oneOf.map((entry) => parseNode(entry, context, depth + 1));
  return Object.freeze({
    oneOf: Object.freeze(oneOf),
    discriminator: Object.freeze({ propertyName }),
  });
}

function parseEnum(record: Record<string, unknown>): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["enum"]);
  if (!Array.isArray(record.enum) || record.enum.length < 1 || record.enum.length > MAX_CLOSED_SCHEMA_ENUM_VALUES) {
    throw new Error("enum exceeds its value bounds");
  }
  const values = record.enum.map((entry) => parseScalar(entry, "enum value"));
  const keys = values.map(scalarKey);
  if (new Set(keys).size !== keys.length) throw new Error("enum contains duplicate values");
  return Object.freeze({ enum: Object.freeze(values) });
}

function parseConst(record: Record<string, unknown>): ClosedProviderSchemaNodeV1 {
  assertExactKeys(record, ["const"]);
  return Object.freeze({ const: parseScalar(record.const, "const value") });
}

function withoutKey(record: Record<string, unknown>, omitted: string): Record<string, unknown> {
  const result = emptyRecord<unknown>();
  for (const [key, value] of Object.entries(record)) if (key !== omitted) result[key] = value;
  return result;
}

function emptyRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!accepted.has(key)) throw new Error(`unsupported field in closed provider schema: ${key}`);
  }
}

function assertNoPrototypeKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_KEYS.has(key)) throw new Error("schema node uses a forbidden prototype key");
  }
}

function assertDynamicKey(value: string, label: string): void {
  if (PROTOTYPE_KEYS.has(value)) throw new Error(`${label} uses a forbidden prototype key`);
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > MAX_DYNAMIC_KEY_BYTES) {
    throw new Error(`${label} exceeds its key byte bounds`);
  }
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a bounded nonnegative integer`);
  }
  return value as number;
}

function optionalBoundedInteger(
  value: unknown,
  label: string,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, label, maximum);
}

function finiteNumber(value: unknown, label: string, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function optionalAllowedString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`unsupported closed provider schema ${label}`);
  }
  return value as T;
}

function parseScalar(value: unknown, label: string): ClosedProviderJsonScalarV1 {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${label} must be a finite JSON scalar`);
}

function scalarKey(value: ClosedProviderJsonScalarV1): string {
  return `${value === null ? "null" : typeof value}:${String(value)}`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function countMember(context: ParseContext): void {
  context.members += 1;
  if (context.members > MAX_CLOSED_SCHEMA_MEMBERS) {
    throw new Error("closed provider schema exceeds its aggregate member cap");
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
