/**
 * @file src/capability-providers/schema/validate.ts
 * @description Host-owned, no-coercion validation for compiled Provider V2
 * schemas. Results and attacker-influenced error details are strictly bounded.
 */
import {
  MAX_CLOSED_SCHEMA_DEPTH,
  MAX_CLOSED_SCHEMA_ERROR_BYTES,
  MAX_CLOSED_SCHEMA_ERRORS,
  MAX_CLOSED_SCHEMA_MEMBERS,
} from "./types.js";
import type {
  ClosedProviderArraySchemaV1,
  ClosedProviderDiscriminatedUnionSchemaV1,
  ClosedProviderNumberSchemaV1,
  ClosedProviderObjectSchemaV1,
  ClosedProviderReferenceSchemaV1,
  ClosedProviderSchemaNodeV1,
  ClosedProviderSchemaV1,
  ClosedProviderStringSchemaV1,
  ClosedProviderValidationErrorCodeV1,
  ClosedProviderValidationErrorV1,
  ClosedProviderValidationResultV1,
  CompiledClosedProviderSchemaV1,
} from "./types.js";
import type { Sha256Digest } from "../types.js";

type Validator = (value: unknown) => ClosedProviderValidationResultV1;
type ResolvedSchemaNode = Exclude<ClosedProviderSchemaNodeV1, ClosedProviderReferenceSchemaV1>;
type SpecialSchemaNode = Extract<
  ResolvedSchemaNode,
  { readonly oneOf: unknown } | { readonly enum: unknown } | { readonly const: unknown }
>;
type TypedSchemaNode = Exclude<ResolvedSchemaNode, SpecialSchemaNode>;
const compiledValidators = new WeakMap<object, Validator>();

interface ValidationContext {
  readonly definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>;
  readonly errors: ClosedProviderValidationErrorV1[];
  readonly seen: WeakSet<object>;
  members: number;
}

/** @internal Mint the opaque compiled handle consumed by public validation. */
export function registerCompiledClosedProviderSchema(
  digest: Sha256Digest,
  schema: ClosedProviderSchemaV1,
): CompiledClosedProviderSchemaV1 {
  const compiled = Object.freeze({ digest }) as CompiledClosedProviderSchemaV1;
  compiledValidators.set(compiled, createValidator(schema));
  return compiled;
}

/** Validate a parsed structured value without coercion, defaults, or mutation. */
export function validateClosedProviderValue(
  compiled: CompiledClosedProviderSchemaV1,
  value: unknown,
): ClosedProviderValidationResultV1 {
  const validate = compiledValidators.get(compiled);
  if (!validate) throw new Error("closed provider schema was not compiled by the host");
  return validate(value);
}

function createValidator(schema: ClosedProviderSchemaV1): Validator {
  return (value) => {
    const context: ValidationContext = {
      definitions: schema.$defs ?? {},
      errors: [],
      seen: new WeakSet(),
      members: 0,
    };
    validateNode(schema, value, "", context, 0);
    const errors = Object.freeze(context.errors.map((error) => Object.freeze(error)));
    return Object.freeze({ valid: errors.length === 0, errors });
  };
}

function validateNode(
  schema: ClosedProviderSchemaNodeV1,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if (!reserveValidationMember(value, path, context, depth)) return;
  const resolved = resolveReference(schema, context.definitions);
  if (isSpecialSchemaNode(resolved)) validateSpecialNode(resolved, value, path, context, depth);
  else validateTypedNode(resolved, value, path, context, depth);
}

function validateSpecialNode(
  schema: SpecialSchemaNode,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if ("oneOf" in schema) validateUnion(schema, value, path, context, depth);
  else if ("enum" in schema) validateEnum(schema.enum, value, path, context);
  else if ("const" in schema) validateConst(schema.const, value, path, context);
}

function validateTypedNode(
  schema: TypedSchemaNode,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if (schema.type === "object") validateObject(schema, value, path, context, depth);
  else if (schema.type === "array") validateArray(schema, value, path, context, depth);
  else if (schema.type === "string") validateString(schema, value, path, context);
  else if (schema.type === "number" || schema.type === "integer") {
    validateNumber(schema, value, path, context);
  } else validatePrimitiveType(schema.type, value, path, context);
}

function isSpecialSchemaNode(schema: ResolvedSchemaNode): schema is SpecialSchemaNode {
  return "oneOf" in schema || "enum" in schema || "const" in schema;
}

function reserveValidationMember(
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): boolean {
  context.members += 1;
  if (depth > MAX_CLOSED_SCHEMA_DEPTH || context.members > MAX_CLOSED_SCHEMA_MEMBERS) {
    addError(context, path, "resource-limit", "structured value exceeds validation bounds");
    return false;
  }
  if (typeof value !== "object" || value === null) return true;
  if (context.seen.has(value)) {
    addError(context, path, "resource-limit", "structured value contains a cycle");
    return false;
  }
  context.seen.add(value);
  return true;
}

function validateObject(
  schema: ClosedProviderObjectSchemaV1,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if (!isRecord(value)) return addError(context, path, "type", "expected object");
  const required = [...(schema.required ?? [])].sort();
  for (const name of required) {
    if (!hasOwn(value, name)) addError(context, childPath(path, name), "required", "required property is missing");
  }
  const propertyNames = Object.keys(schema.properties).sort();
  for (const name of propertyNames) {
    if (hasOwn(value, name)) {
      validateNode(schema.properties[name], value[name], childPath(path, name), context, depth + 1);
    }
  }
  for (const name of Object.keys(value).sort()) {
    if (!hasOwn(schema.properties, name)) {
      addError(context, childPath(path, name), "additional-property", "additional property is forbidden");
    }
  }
}

function validateArray(
  schema: ClosedProviderArraySchemaV1,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if (!Array.isArray(value)) return addError(context, path, "type", "expected array");
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    addError(context, path, "min-items", `array has fewer than ${schema.minItems} items`);
  }
  if (value.length > schema.maxItems) {
    addError(context, path, "max-items", `array has more than ${schema.maxItems} items`);
  }
  const checkedLength = Math.min(value.length, schema.maxItems);
  for (let index = 0; index < checkedLength; index += 1) {
    validateNode(schema.items, value[index], childPath(path, String(index)), context, depth + 1);
  }
}

function validateString(
  schema: ClosedProviderStringSchemaV1,
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (typeof value !== "string") return addError(context, path, "type", "expected string");
  if (schema.minLength !== undefined && [...value].length < schema.minLength) {
    addError(context, path, "min-length", `string is shorter than ${schema.minLength} characters`);
  }
  if ([...value].length > schema.maxLength) {
    addError(context, path, "max-length", `string is longer than ${schema.maxLength} characters`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    addError(context, path, "pattern", "string does not match the registered safe pattern");
  }
  if (schema.format !== undefined && !matchesFormat(schema.format, value)) {
    addError(context, path, "format", `string does not match registered format ${schema.format}`);
  }
}

function validateNumber(
  schema: ClosedProviderNumberSchemaV1,
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  const validType = typeof value === "number"
    && Number.isFinite(value)
    && (schema.type !== "integer" || Number.isInteger(value));
  if (!validType) return addError(context, path, "type", `expected ${schema.type}`);
  if ((value as number) < schema.minimum) {
    addError(context, path, "minimum", `number is below minimum ${schema.minimum}`);
  }
  if ((value as number) > schema.maximum) {
    addError(context, path, "maximum", `number is above maximum ${schema.maximum}`);
  }
}

function validatePrimitiveType(
  type: "boolean" | "null",
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  const valid = type === "null" ? value === null : typeof value === "boolean";
  if (!valid) addError(context, path, "type", `expected ${type}`);
}

function validateEnum(
  allowed: readonly unknown[],
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (!allowed.some((candidate) => scalarEqual(candidate, value))) {
    addError(context, path, "enum", "value is not a declared enum member");
  }
}

function validateConst(
  expected: unknown,
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (!scalarEqual(expected, value)) addError(context, path, "const", "value does not match const");
}

function validateUnion(
  schema: ClosedProviderDiscriminatedUnionSchemaV1,
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number,
): void {
  if (!isRecord(value)) return addError(context, path, "type", "expected object union value");
  const discriminator = value[schema.discriminator.propertyName];
  if (typeof discriminator !== "string") {
    return addError(context, childPath(path, schema.discriminator.propertyName), "union-discriminator", "union discriminator must be a string");
  }
  const branch = schema.oneOf.map((candidate) => resolveReference(candidate, context.definitions)).find((candidate) => {
    if (!("type" in candidate) || candidate.type !== "object") return false;
    const tag = candidate.properties[schema.discriminator.propertyName];
    return tag !== undefined && "const" in tag && tag.const === discriminator;
  });
  if (!branch) {
    return addError(context, childPath(path, schema.discriminator.propertyName), "union-discriminator", "union discriminator is not declared");
  }
  validateObject(branch as ClosedProviderObjectSchemaV1, value, path, context, depth + 1);
}

function resolveReference(
  schema: ClosedProviderSchemaNodeV1,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): ResolvedSchemaNode {
  let resolved = schema;
  while ("$ref" in resolved) {
    const name = resolved.$ref.slice("#/$defs/".length);
    if (!hasOwn(definitions, name)) throw new Error(`compiled schema references missing definition: ${name}`);
    resolved = definitions[name];
  }
  return resolved as ResolvedSchemaNode;
}

function matchesFormat(format: "date-time" | "uri", value: string): boolean {
  if (format === "date-time") {
    const parsed = Date.parse(value);
    const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
      && !Number.isNaN(parsed)
      && new Date(parsed).toISOString() === normalized;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function addError(
  context: ValidationContext,
  path: string,
  code: ClosedProviderValidationErrorCodeV1,
  detail: string,
): void {
  if (context.errors.length >= MAX_CLOSED_SCHEMA_ERRORS) return;
  context.errors.push({
    path: boundedText(path || "/", MAX_CLOSED_SCHEMA_ERROR_BYTES),
    code,
    detail: boundedText(detail, MAX_CLOSED_SCHEMA_ERROR_BYTES),
  });
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximumBytes) break;
    result += character;
  }
  return result;
}

function childPath(parent: string, key: string): string {
  const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escaped}`;
}

function scalarEqual(left: unknown, right: unknown): boolean {
  return typeof left === typeof right && left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
