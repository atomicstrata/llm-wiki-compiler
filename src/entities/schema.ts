/**
 * @file src/entities/schema.ts
 * @description What compile's entity extraction asks for, derived from the
 * profile: which entity types opt in (`extract` on the type), the closed JSON
 * schema the model answers in (one array per type; each record a name, the
 * type's declared fields, and the line ranges that mention it), and the
 * structural digest the extraction cache is keyed on.
 *
 * The digest covers only structure: the record shape every type shares, type
 * names, field names, field types and enum values. A type's `description` and per-field guidance are prompt text, so
 * rewording them never invalidates cached extractions; adding a type or a field
 * does, because the cached answers cannot contain it.
 *
 * Every property is required and an unknown value is `null` rather than absent,
 * which is what strict structured-output providers accept.
 */

import { createHash } from "node:crypto";
import type { EntityExtractDef, EntityTypeDef, FieldDef, ProfilePack } from "../profile/types.js";

/** Field types extraction can fill from text; references and artifacts are not read from sources. */
const EXTRACTABLE_FIELD_TYPES = new Set(["string", "slug", "date", "enum", "string[]", "number", "integer", "boolean"]);

/** The version of the record shape every type shares (`name`, `writtenAs`, `lines`); part of the digest. */
const RECORD_SHAPE_VERSION = 2;

/** An entity type opted into extraction, with the fields extraction fills. */
export interface ExtractableType {
  type: string;
  def: EntityTypeDef & { extract: EntityExtractDef };
  /** Declared fields extraction fills, in name order. */
  fields: [string, FieldDef][];
}

/** The entity types a profile opts into extraction, in name order. */
export function extractableTypes(profile: ProfilePack): ExtractableType[] {
  return Object.entries(profile.entities)
    .filter((entry): entry is [string, EntityTypeDef & { extract: EntityExtractDef }] => entry[1].extract !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, def]) => ({
      type,
      def,
      fields: Object.entries(def.fields ?? {})
        .filter(([name, field]) => EXTRACTABLE_FIELD_TYPES.has(field.type) && name !== def.titleField)
        .sort(([a], [b]) => a.localeCompare(b)),
    }));
}

/** The digest of what extraction's answers can contain; equal digests mean cached answers still fit. */
export function structuralDigest(types: ExtractableType[]): string {
  const structure = types.map(({ type, fields }) => [type, fields.map(([name, field]) => [name, field.type, [...(field.enum ?? [])].sort()])]);
  return createHash("sha256").update(JSON.stringify([RECORD_SHAPE_VERSION, structure])).digest("hex").slice(0, 16);
}

/** The JSON schema of one field's answer: nullable, and closed for an enum. */
function fieldSchema(field: FieldDef): Record<string, unknown> {
  if (field.type === "string[]") return { type: "array", items: { type: "string" } };
  if (field.type === "enum") return { type: ["string", "null"], enum: [...(field.enum ?? []), null] };
  if (field.type === "number" || field.type === "integer") return { type: [field.type, "null"] };
  if (field.type === "boolean") return { type: ["boolean", "null"] };
  return { type: ["string", "null"] };
}

const LINE_RANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end"],
  properties: { start: { type: "integer" }, end: { type: "integer" } },
};

/** The schema of one record of `type`: who it is, how the source writes it, its fields, and the lines that mention it. */
function recordSchema({ fields }: ExtractableType): Record<string, unknown> {
  const properties: Record<string, unknown> = { name: { type: "string" }, writtenAs: { type: "array", items: { type: "string" } } };
  for (const [name, field] of fields) properties[name] = fieldSchema(field);
  properties.lines = { type: "array", items: LINE_RANGE_SCHEMA };
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

/** The extraction tool: one array of records per extractable type. */
export function extractionTool(types: ExtractableType[]): { name: string; description: string; input_schema: Record<string, unknown> } {
  const properties = Object.fromEntries(types.map((type) => [type.type, { type: "array", items: recordSchema(type) }]));
  return {
    name: "extract_records",
    description: "List the records of each type that a source names: who each is, how the source writes them, and the lines that mention them",
    input_schema: { type: "object", additionalProperties: false, required: types.map(({ type }) => type), properties },
  };
}
