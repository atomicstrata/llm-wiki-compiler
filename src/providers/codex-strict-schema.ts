/**
 * @file src/providers/codex-strict-schema.ts
 * @description Codex structured output accepts only strict JSON schemas: every
 * object must set `additionalProperties: false` and list every one of its
 * properties in `required`, at every depth. llmwiki's tool schemas are written
 * for providers that allow optional properties, and Codex rejected them with
 * `invalid_json_schema` (#266).
 *
 * `toStrictSchema` returns a strict copy that keeps each optional property's
 * meaning: the property becomes required but nullable, so the model answers
 * `null` where it would have left the property out. `dropNullOptionals` undoes
 * that on the reply, removing the `null` values the strict copy introduced, so
 * the result can be validated against the original schema unchanged. Neither
 * function modifies its input; tool schemas are shared, and one feeds a cache
 * key.
 */

type JsonSchema = Record<string, unknown>;

/** A strict copy of `schema`: objects closed, properties required, optionals nullable. */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const strict: JsonSchema = { ...schema };
  if (isRecord(schema.items)) strict.items = toStrictSchema(schema.items);
  if (Array.isArray(schema.anyOf)) strict.anyOf = schema.anyOf.map(branch => isRecord(branch) ? toStrictSchema(branch) : branch);
  if (!isRecord(schema.properties)) return strict;
  const required = new Set(requiredNames(schema));
  const properties: JsonSchema = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!isRecord(property)) continue;
    const closed = toStrictSchema(property);
    properties[name] = required.has(name) ? closed : nullable(closed);
  }
  return { ...strict, properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * Remove the `null` answers a strict schema allowed for properties the
 * original schema left optional, at every depth. Other values are copied
 * unchanged, so validation against the original schema still decides.
 */
export function dropNullOptionals(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) {
    return isRecord(schema.items) ? value.map(item => dropNullOptionals(item, schema.items as JsonSchema)) : value;
  }
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  const required = new Set(requiredNames(schema));
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    const property = schema.properties[name];
    if (entry === null && !required.has(name) && isRecord(property)) continue;
    result[name] = isRecord(property) ? dropNullOptionals(entry, property) : entry;
  }
  return result;
}

/** The property names `schema` lists as required. */
function requiredNames(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
}

/** `schema` that also accepts `null`, keeping its type, enum and description together where possible. */
function nullable(schema: JsonSchema): JsonSchema {
  if (typeof schema.type !== "string") return { anyOf: [schema, { type: "null" }] };
  const result: JsonSchema = { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.enum)) result.enum = [...schema.enum, null];
  return result;
}

/** Whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
