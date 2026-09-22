/**
 * @file test/capability-providers/schema-negative-sweep.test.ts
 * @description Table-driven rejection coverage for every forbidden Provider V2
 * schema feature, missing bound, prototype key, and structural resource cap.
 */
import { describe, expect, it } from "vitest";
import { parseClosedProviderSchema } from "../../src/capability-providers/schema/parse.js";

interface RejectionCase {
  readonly name: string;
  readonly schema: unknown | string;
  readonly message: RegExp;
}

const VALID_STRING = { type: "string", maxLength: 20 };
const VALID_OBJECT = {
  type: "object",
  properties: { value: VALID_STRING },
  required: ["value"],
  additionalProperties: false,
};

const FIXED_REJECTIONS: readonly RejectionCase[] = [
  { name: "unknown top-level field", schema: { ...VALID_STRING, $schema: "https://json-schema.org" }, message: /unsupported field/ },
  { name: "remote reference", schema: { $ref: "https://example.test/schema" }, message: /local reference/ },
  { name: "dangling local reference", schema: { $ref: "#\/$defs\/missing" }, message: /missing definition/ },
  { name: "object without additionalProperties", schema: { type: "object", properties: {} }, message: /additionalProperties/ },
  { name: "open object", schema: { type: "object", properties: {}, additionalProperties: true }, message: /additionalProperties/ },
  { name: "array without items", schema: { type: "array", maxItems: 2 }, message: /items/ },
  { name: "array without maximum", schema: { type: "array", items: VALID_STRING }, message: /maxItems/ },
  { name: "string without maximum", schema: { type: "string" }, message: /maxLength/ },
  { name: "number without minimum", schema: { type: "number", maximum: 1 }, message: /minimum/ },
  { name: "number without maximum", schema: { type: "number", minimum: 0 }, message: /maximum/ },
  { name: "integer without minimum", schema: { type: "integer", maximum: 1 }, message: /minimum/ },
  { name: "integer without maximum", schema: { type: "integer", minimum: 0 }, message: /maximum/ },
  { name: "unregistered format", schema: { ...VALID_STRING, format: "email" }, message: /format/ },
  { name: "lookaround regex", schema: { ...VALID_STRING, pattern: "^(?=a).*$" }, message: /pattern/ },
  { name: "backreference regex", schema: { ...VALID_STRING, pattern: "^(a)\\1$" }, message: /pattern/ },
  { name: "default", schema: { ...VALID_STRING, default: "x" }, message: /unsupported field/ },
  { name: "transform", schema: { ...VALID_STRING, transform: ["trim"] }, message: /unsupported field/ },
  { name: "coercion", schema: { ...VALID_STRING, coerce: true }, message: /unsupported field/ },
  { name: "executable validator", schema: { ...VALID_STRING, validate: "return true" }, message: /unsupported field/ },
  { name: "pattern properties", schema: { ...VALID_OBJECT, patternProperties: {} }, message: /unsupported field/ },
  { name: "anyOf", schema: { anyOf: [VALID_STRING] }, message: /unsupported/ },
  { name: "oneOf without discriminator", schema: { oneOf: [VALID_OBJECT] }, message: /discriminator/ },
  { name: "unknown primitive type", schema: { type: "undefined" }, message: /schema type/ },
  { name: "non-finite numeric bound", schema: '{"type":"number","minimum":0,"maximum":1e400}', message: /finite/ },
  { name: "root prototype field", schema: '{"__proto__":{"type":"boolean"}}', message: /prototype key/ },
  { name: "inherited definition lookup", schema: { $ref: "#/$defs/toString" }, message: /missing definition/ },
  { name: "prototype property", schema: '{"type":"object","properties":{"__proto__":{"type":"boolean"}},"additionalProperties":false}', message: /prototype key/ },
  { name: "constructor definition", schema: '{"$defs":{"constructor":{"type":"boolean"}},"type":"boolean"}', message: /prototype key/ },
];

function cyclicDefinitions(): unknown {
  return {
    $defs: { first: { $ref: "#/$defs/second" }, second: { $ref: "#/$defs/first" } },
    $ref: "#/$defs/first",
  };
}

function duplicateUnionTags(): unknown {
  const branch = {
    type: "object",
    properties: { kind: { const: "same" } },
    required: ["kind"],
    additionalProperties: false,
  };
  return { oneOf: [branch, branch], discriminator: { propertyName: "kind" } };
}

function missingUnionTagRequirement(): unknown {
  return {
    oneOf: [{
      type: "object",
      properties: { kind: { const: "one" } },
      required: [],
      additionalProperties: false,
    }],
    discriminator: { propertyName: "kind" },
  };
}

function invalidUnionDefinition(): unknown {
  return {
    $defs: { invalid: missingUnionTagRequirement() },
    $ref: "#/$defs/invalid",
  };
}

function tooManyDefinitions(): unknown {
  const definitions = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`definition${index}`, { type: "boolean" }]),
  );
  return { $defs: definitions, type: "boolean" };
}

function tooManySchemaMembers(): unknown {
  const properties = Object.fromEntries(
    Array.from({ length: 2_049 }, (_, index) => [`field${index}`, {
      type: "object",
      properties: { value: { type: "boolean" } },
      additionalProperties: false,
    }]),
  );
  return { type: "object", properties, additionalProperties: false };
}

function tooDeepSchema(): unknown {
  let schema: unknown = { type: "boolean" };
  for (let index = 0; index < 33; index += 1) {
    schema = { type: "array", items: schema, maxItems: 1 };
  }
  return schema;
}

function nestedArrays(leaf: unknown, depth: number): unknown {
  let schema = leaf;
  for (let index = 0; index < depth; index += 1) {
    schema = { type: "array", items: schema, maxItems: 1 };
  }
  return schema;
}

function tooDeepExpandedSchema(): unknown {
  const root = nestedArrays({ $ref: "#/$defs/tail" }, 20) as Record<string, unknown>;
  return {
    ...root,
    $defs: { tail: nestedArrays({ type: "boolean" }, 20) },
  };
}

const GENERATED_REJECTIONS: readonly RejectionCase[] = [
  { name: "cyclic local reference", schema: cyclicDefinitions(), message: /cyclic/ },
  { name: "duplicate union tag", schema: duplicateUnionTags(), message: /discriminator tag/ },
  { name: "optional union tag", schema: missingUnionTagRequirement(), message: /required discriminator/ },
  { name: "invalid union hidden in a definition", schema: invalidUnionDefinition(), message: /required discriminator/ },
  { name: "definition count cap", schema: tooManyDefinitions(), message: /definition cap/ },
  { name: "aggregate member cap", schema: tooManySchemaMembers(), message: /member cap/ },
  { name: "semantic depth cap", schema: tooDeepSchema(), message: /depth cap/ },
  { name: "effective expanded depth cap", schema: tooDeepExpandedSchema(), message: /expanded depth cap/ },
];

describe("closed provider schema negative grammar sweep", () => {
  it.each([...FIXED_REJECTIONS, ...GENERATED_REJECTIONS])("rejects $name", ({ schema, message }) => {
    const text = typeof schema === "string" ? schema : JSON.stringify(schema);
    expect(() => parseClosedProviderSchema(text)).toThrow(message);
  });
});
