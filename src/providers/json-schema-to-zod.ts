/**
 * Minimal JSON-Schema → Zod converter for the Claude Agent SDK.
 *
 * The Agent SDK's `tool()` helper takes a Zod *raw shape* (a record of Zod
 * types keyed by property name), but llmwiki declares its tools as JSON Schema
 * (`LLMTool.input_schema`). This converts the subset of JSON Schema that every
 * llmwiki tool uses — object / array / string / number / boolean / enum, with
 * a `required` list — into the raw shape the SDK expects. It is intentionally
 * narrow: unsupported nodes fall back to `z.unknown()` rather than throwing.
 *
 * Two contract details are preserved so the SDK path matches the raw API path:
 * numeric/boolean enums keep their literal types (e.g. eval scores `0 | 1 | 2`,
 * not `"0" | "1" | "2"`), and field `description`s carry through via `.describe`.
 */

import { z, type ZodType } from "zod";

/** The slice of JSON Schema this converter understands. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
  description?: string;
}

/** Builders for primitive JSON Schema types, keyed by `type`. */
const SCALAR_BUILDERS: Record<string, () => ZodType> = {
  string: () => z.string(),
  number: () => z.number(),
  integer: () => z.number(),
  boolean: () => z.boolean(),
};

/** Build a Zod type for an enum, keeping numeric/boolean values as literals. */
function enumToZod(values: unknown[]): ZodType {
  if (values.every((value) => typeof value === "string")) {
    return z.enum(values as [string, ...string[]]);
  }
  const literals = values.map((value) => z.literal(value as string | number | boolean));
  return literals.length === 1
    ? literals[0]
    : z.union(literals as unknown as [ZodType, ZodType, ...ZodType[]]);
}

/** Map a JSON Schema node to a Zod type, ignoring any field description. */
function baseType(node: JsonSchemaNode): ZodType {
  if (Array.isArray(node.enum) && node.enum.length > 0) return enumToZod(node.enum);
  const scalar = node.type ? SCALAR_BUILDERS[node.type] : undefined;
  if (scalar) return scalar();
  if (node.type === "array") {
    return z.array(node.items ? nodeToZod(node.items) : z.unknown());
  }
  if (node.type === "object") return z.object(shapeFromProperties(node));
  return z.unknown();
}

/** Convert a node to a Zod type, carrying its description through via .describe(). */
function nodeToZod(node: JsonSchemaNode): ZodType {
  const zodType = baseType(node);
  return node.description ? zodType.describe(node.description) : zodType;
}

/** Build a Zod raw shape from an object schema's properties + required list. */
function shapeFromProperties(schema: JsonSchemaNode): Record<string, ZodType> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};
  for (const [key, value] of Object.entries(properties)) {
    const zodType = nodeToZod(value);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }
  return shape;
}

/**
 * Convert an Anthropic-style tool `input_schema` (a JSON Schema object) into
 * the Zod raw shape accepted by the Agent SDK's `tool()` helper.
 */
export function jsonSchemaToZodShape(
  inputSchema: Record<string, unknown>,
): Record<string, ZodType> {
  return shapeFromProperties(inputSchema as JsonSchemaNode);
}
