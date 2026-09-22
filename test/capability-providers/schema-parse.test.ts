/**
 * @file test/capability-providers/schema-parse.test.ts
 * @description Positive parsing coverage for Provider V2's closed, branded,
 * host-owned capability-schema subset.
 */
import { describe, expect, it } from "vitest";
import { parseClosedProviderSchema } from "../../src/capability-providers/schema/parse.js";

const OBJECT_SCHEMA = {
  type: "object",
  properties: {
    active: { type: "boolean" },
    count: { type: "integer", minimum: 0, maximum: 10 },
    ids: {
      type: "array",
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[a-z0-9][a-z0-9._-]*$",
      },
      maxItems: 3,
    },
    name: { type: "string", minLength: 1, maxLength: 40 },
    nothing: { type: "null" },
    role: { enum: ["author", "reviewer"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    version: { const: 1 },
  },
  required: ["name", "score"],
  additionalProperties: false,
};

const UNION_SCHEMA = {
  $defs: {
    alpha: {
      type: "object",
      properties: {
        kind: { const: "alpha" },
        value: { type: "string", maxLength: 20 },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    beta: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 0, maximum: 10 },
        kind: { const: "beta" },
      },
      required: ["kind", "count"],
      additionalProperties: false,
    },
  },
  oneOf: [{ $ref: "#/$defs/alpha" }, { $ref: "#/$defs/beta" }],
  discriminator: { propertyName: "kind" },
};

describe("closed provider schema parsing", () => {
  it("assembles and freezes each allowlisted schema node", () => {
    const parsed = parseClosedProviderSchema(JSON.stringify(OBJECT_SCHEMA));
    expect(parsed.schema).toEqual(OBJECT_SCHEMA);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.schema)).toBe(true);
    if (!("properties" in parsed.schema)) throw new Error("expected object schema");
    expect(Object.isFrozen(parsed.schema.properties)).toBe(true);
  });

  it("accepts bounded local discriminated unions", () => {
    const parsed = parseClosedProviderSchema(JSON.stringify(UNION_SCHEMA));
    expect(parsed.schema).toEqual(UNION_SCHEMA);
  });

  it("allows an explicitly declared definition named toString", () => {
    const schema = {
      $defs: { toString: { type: "boolean" } },
      $ref: "#/$defs/toString",
    };
    expect(parseClosedProviderSchema(JSON.stringify(schema)).schema).toEqual(schema);
  });

  it("rejects duplicate JSON keys before native parsing collapses them", () => {
    const text = '{"type":"string","maxLength":4,"maxLength":8}';
    expect(() => parseClosedProviderSchema(text)).toThrow(/duplicate JSON key/);
  });

  it("does not retain mutable caller-owned schema objects", () => {
    const callerOwned = structuredClone(OBJECT_SCHEMA);
    const parsed = parseClosedProviderSchema(JSON.stringify(callerOwned));
    callerOwned.properties.name.maxLength = 1;
    expect(parsed.schema).toEqual(OBJECT_SCHEMA);
  });
});
