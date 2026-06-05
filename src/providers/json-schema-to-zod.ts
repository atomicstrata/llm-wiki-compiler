/**
 * Minimal JSON-Schema → Zod converter for the Claude Agent SDK.
 *
 * The Agent SDK's `tool()` helper takes a Zod *raw shape* (a record of Zod
 * types keyed by property name), but llmwiki declares its tools as JSON Schema
 * (`LLMTool.input_schema`). This converts the subset of JSON Schema that every
 * llmwiki tool uses — object / array / string / number / boolean / enum, with
 * a `required` list — into the raw shape the SDK expects. It is intentionally
 * narrow: unsupported nodes fall back to `z.unknown()` rather than throwing.
 */

import { z, type ZodType } from "zod";

/** The slice of JSON Schema this converter understands. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: unknown[];
}

/** Builders for primitive JSON Schema types, keyed by `type`. */
const SCALAR_BUILDERS: Record<string, () => ZodType> = {
  string: () => z.string(),
  number: () => z.number(),
  integer: () => z.number(),
  boolean: () => z.boolean(),
};

/** Convert a single JSON Schema node into a Zod type. */
function nodeToZod(node: JsonSchemaNode): ZodType {
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return z.enum(node.enum.map(String) as [string, ...string[]]);
  }
  const scalar = node.type ? SCALAR_BUILDERS[node.type] : undefined;
  if (scalar) return scalar();
  if (node.type === "array") {
    return z.array(node.items ? nodeToZod(node.items) : z.unknown());
  }
  if (node.type === "object") return z.object(shapeFromProperties(node));
  return z.unknown();
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
