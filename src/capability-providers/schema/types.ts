/**
 * @file src/capability-providers/schema/types.ts
 * @description Closed Provider V2 schema nodes plus branded parse, compile,
 * and validation records. Raw package JSON cannot satisfy the branded APIs.
 */
import type { Sha256Digest } from "../types.js";

declare const parsedClosedSchemaBrand: unique symbol;
declare const compiledClosedSchemaBrand: unique symbol;

export const MAX_CLOSED_SCHEMA_DEFINITIONS = 128;
export const MAX_CLOSED_SCHEMA_DEPTH = 32;
export const MAX_CLOSED_SCHEMA_MEMBERS = 4_096;
export const MAX_CLOSED_SCHEMA_PROPERTIES = 4_096;
export const MAX_CLOSED_SCHEMA_ENUM_VALUES = 256;
export const MAX_CLOSED_SCHEMA_STRING_LENGTH = 1_000_000;
export const MAX_CLOSED_SCHEMA_ARRAY_ITEMS = 4_096;
export const MAX_CLOSED_SCHEMA_ERRORS = 32;
export const MAX_CLOSED_SCHEMA_ERROR_BYTES = 256;

export const CLOSED_PROVIDER_SCHEMA_FORMATS = Object.freeze([
  "date-time",
  "uri",
] as const);
export const CLOSED_PROVIDER_SCHEMA_PATTERNS = Object.freeze([
  "^[a-z0-9][a-z0-9._-]*$",
  "^sha256:[0-9a-f]{64}$",
] as const);

export type ClosedProviderSchemaFormatV1 =
  (typeof CLOSED_PROVIDER_SCHEMA_FORMATS)[number];
export type ClosedProviderSchemaPatternV1 =
  (typeof CLOSED_PROVIDER_SCHEMA_PATTERNS)[number];
export type ClosedProviderJsonScalarV1 = null | boolean | number | string;

export interface ClosedProviderObjectSchemaV1 {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ClosedProviderSchemaNodeV1>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ClosedProviderArraySchemaV1 {
  readonly type: "array";
  readonly items: ClosedProviderSchemaNodeV1;
  readonly minItems?: number;
  readonly maxItems: number;
}

export interface ClosedProviderStringSchemaV1 {
  readonly type: "string";
  readonly minLength?: number;
  readonly maxLength: number;
  readonly pattern?: ClosedProviderSchemaPatternV1;
  readonly format?: ClosedProviderSchemaFormatV1;
}

export interface ClosedProviderNumberSchemaV1 {
  readonly type: "number" | "integer";
  readonly minimum: number;
  readonly maximum: number;
}

export interface ClosedProviderBooleanSchemaV1 {
  readonly type: "boolean";
}

export interface ClosedProviderNullSchemaV1 {
  readonly type: "null";
}

export interface ClosedProviderEnumSchemaV1 {
  readonly enum: readonly ClosedProviderJsonScalarV1[];
}

export interface ClosedProviderConstSchemaV1 {
  readonly const: ClosedProviderJsonScalarV1;
}

export interface ClosedProviderReferenceSchemaV1 {
  readonly $ref: `#/$defs/${string}`;
}

export interface ClosedProviderDiscriminatedUnionSchemaV1 {
  readonly oneOf: readonly ClosedProviderSchemaNodeV1[];
  readonly discriminator: Readonly<{ propertyName: string }>;
}

export type ClosedProviderSchemaNodeV1 =
  | ClosedProviderObjectSchemaV1
  | ClosedProviderArraySchemaV1
  | ClosedProviderStringSchemaV1
  | ClosedProviderNumberSchemaV1
  | ClosedProviderBooleanSchemaV1
  | ClosedProviderNullSchemaV1
  | ClosedProviderEnumSchemaV1
  | ClosedProviderConstSchemaV1
  | ClosedProviderReferenceSchemaV1
  | ClosedProviderDiscriminatedUnionSchemaV1;

export type ClosedProviderSchemaV1 = ClosedProviderSchemaNodeV1 & {
  readonly $defs?: Readonly<Record<string, ClosedProviderSchemaNodeV1>>;
};

/** Output of the only untrusted-text parser accepted by the compiler. */
export interface ParsedClosedProviderSchemaV1 {
  readonly schema: ClosedProviderSchemaV1;
  readonly [parsedClosedSchemaBrand]: true;
}

export type ClosedProviderValidationErrorCodeV1 =
  | "additional-property"
  | "const"
  | "enum"
  | "format"
  | "maximum"
  | "max-items"
  | "max-length"
  | "minimum"
  | "min-items"
  | "min-length"
  | "pattern"
  | "required"
  | "resource-limit"
  | "type"
  | "union-discriminator";

export interface ClosedProviderValidationErrorV1 {
  readonly path: string;
  readonly code: ClosedProviderValidationErrorCodeV1;
  readonly detail: string;
}

export interface ClosedProviderValidationResultV1 {
  readonly valid: boolean;
  readonly errors: readonly ClosedProviderValidationErrorV1[];
}

/** Host-compiled validator handle. It exposes no provider-supplied code. */
export interface CompiledClosedProviderSchemaV1 {
  readonly digest: Sha256Digest;
  readonly [compiledClosedSchemaBrand]: true;
}

/** Reject dangling, cyclic, deep, or malformed union references. */
export function assertClosedProviderSchemaSemantics(schema: ClosedProviderSchemaV1): void {
  validateReferenceGraph(schema);
  validateDiscriminatedUnions(schema);
}

function validateReferenceGraph(schema: ClosedProviderSchemaV1): void {
  const definitions = schema.$defs ?? {};
  walkEachNode(schema, (node) => {
    if ("$ref" in node) requireDefinition(node.$ref, definitions);
  });
  const graph = buildDefinitionGraph(definitions);
  const depths = new Map<string, number>();
  for (const name of Object.keys(definitions)) definitionDepth(name, graph, new Set(), depths);
  validateExpandedDepth(schema, definitions);
}

function buildDefinitionGraph(
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): Readonly<Record<string, readonly string[]>> {
  const graph = Object.create(null) as Record<string, readonly string[]>;
  for (const [name, node] of Object.entries(definitions)) {
    const references = new Set<string>();
    walkEachNode(node, (candidate) => {
      if (!("$ref" in candidate)) return;
      requireDefinition(candidate.$ref, definitions);
      references.add(referenceName(candidate.$ref));
    });
    graph[name] = Object.freeze([...references].sort());
  }
  return Object.freeze(graph);
}

function definitionDepth(
  name: string,
  graph: Readonly<Record<string, readonly string[]>>,
  visiting: ReadonlySet<string>,
  depths: Map<string, number>,
): number {
  if (visiting.has(name)) throw new Error("closed provider schema contains a cyclic local reference");
  const known = depths.get(name);
  if (known !== undefined) return known;
  const nextVisiting = new Set(visiting).add(name);
  const descendants = graph[name].map((child) => definitionDepth(child, graph, nextVisiting, depths));
  const depth = 1 + Math.max(0, ...descendants);
  if (depth > MAX_CLOSED_SCHEMA_DEPTH) throw new Error("definition reference chain exceeds its depth cap");
  depths.set(name, depth);
  return depth;
}

function validateExpandedDepth(
  schema: ClosedProviderSchemaNodeV1,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): void {
  const depths = new Map<string, number>();
  const rootDepth = expandedNodeDepth(schema, definitions, new Set(), depths);
  const definitionDepths = Object.keys(definitions).map((name) => (
    expandedDefinitionDepth(name, definitions, new Set(), depths)
  ));
  if (Math.max(rootDepth, 0, ...definitionDepths) > MAX_CLOSED_SCHEMA_DEPTH) {
    throw new Error("closed provider schema exceeds its expanded depth cap");
  }
}

function expandedNodeDepth(
  node: ClosedProviderSchemaNodeV1,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
  visiting: ReadonlySet<string>,
  depths: Map<string, number>,
): number {
  if ("$ref" in node) {
    return expandedDefinitionDepth(referenceName(node.$ref), definitions, visiting, depths);
  }
  const descendants = childNodes(node).map((child) => (
    expandedNodeDepth(child, definitions, visiting, depths)
  ));
  return descendants.length === 0 ? 0 : 1 + Math.max(...descendants);
}

function expandedDefinitionDepth(
  name: string,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
  visiting: ReadonlySet<string>,
  depths: Map<string, number>,
): number {
  const known = depths.get(name);
  if (known !== undefined) return known;
  if (visiting.has(name)) throw new Error("closed provider schema contains a cyclic local reference");
  const nextVisiting = new Set(visiting).add(name);
  const depth = expandedNodeDepth(requireDefinitionName(name, definitions), definitions, nextVisiting, depths);
  depths.set(name, depth);
  return depth;
}

function validateDiscriminatedUnions(schema: ClosedProviderSchemaV1): void {
  const definitions = schema.$defs ?? {};
  for (const root of [schema, ...Object.values(definitions)]) {
    walkEachNode(root, (node) => {
      if (!("oneOf" in node)) return;
      const tags = node.oneOf.map((branch) => unionTag(branch, node.discriminator.propertyName, definitions));
      if (new Set(tags).size !== tags.length) {
        throw new Error("discriminated union repeats a discriminator tag");
      }
    });
  }
}

function unionTag(
  branch: ClosedProviderSchemaNodeV1,
  propertyName: string,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): string {
  const resolved = resolveReference(branch, definitions);
  if (!("type" in resolved) || resolved.type !== "object") {
    throw new Error("discriminated union branch must resolve to an object schema");
  }
  if (!resolved.required?.includes(propertyName)) {
    throw new Error("union branch must include its required discriminator property");
  }
  const property = resolved.properties[propertyName];
  if (!property || !("const" in property) || typeof property.const !== "string") {
    throw new Error("union discriminator property must declare a string const tag");
  }
  return property.const;
}

function resolveReference(
  node: ClosedProviderSchemaNodeV1,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): ClosedProviderSchemaNodeV1 {
  let current = node;
  while ("$ref" in current) current = requireDefinition(current.$ref, definitions);
  return current;
}

function requireDefinition(
  reference: string,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): ClosedProviderSchemaNodeV1 {
  const name = referenceName(reference);
  return requireDefinitionName(name, definitions);
}

function requireDefinitionName(
  name: string,
  definitions: Readonly<Record<string, ClosedProviderSchemaNodeV1>>,
): ClosedProviderSchemaNodeV1 {
  if (!hasOwn(definitions, name)) throw new Error(`schema references missing definition: ${name}`);
  return definitions[name];
}

function walkEachNode(
  node: ClosedProviderSchemaNodeV1,
  visit: (node: ClosedProviderSchemaNodeV1) => void,
): void {
  visit(node);
  for (const child of childNodes(node)) walkEachNode(child, visit);
}

function childNodes(node: ClosedProviderSchemaNodeV1): readonly ClosedProviderSchemaNodeV1[] {
  if ("type" in node && node.type === "object") return Object.values(node.properties);
  if ("type" in node && node.type === "array") return [node.items];
  if ("oneOf" in node) return node.oneOf;
  return [];
}

function referenceName(reference: string): string {
  return reference.slice("#/$defs/".length);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type AssertFalse<Value extends false> = Value;
type _RawSchemaCannotCompile = AssertFalse<
  IsAssignable<ClosedProviderSchemaV1, ParsedClosedProviderSchemaV1>
>;
type _ParsedSchemaCannotValidate = AssertFalse<
  IsAssignable<ParsedClosedProviderSchemaV1, CompiledClosedProviderSchemaV1>
>;
