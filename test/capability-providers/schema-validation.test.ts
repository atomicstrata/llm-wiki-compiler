/**
 * @file test/capability-providers/schema-validation.test.ts
 * @description Deterministic compilation and no-coercion runtime validation
 * coverage for Provider V2 capability schemas.
 */
import { describe, expect, it } from "vitest";
import { compileClosedProviderSchema } from "../../src/capability-providers/schema/compile.js";
import { parseClosedProviderSchema } from "../../src/capability-providers/schema/parse.js";
import { validateClosedProviderValue } from "../../src/capability-providers/schema/validate.js";

function compile(schema: unknown) {
  return compileClosedProviderSchema(parseClosedProviderSchema(JSON.stringify(schema)));
}

function compileText(schema: string) {
  return compileClosedProviderSchema(parseClosedProviderSchema(schema));
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    at: { type: "string", maxLength: 30, format: "date-time" },
    mode: { enum: ["fast", "deep"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    tags: { type: "array", items: { type: "string", maxLength: 8 }, maxItems: 2 },
  },
  required: ["mode", "score"],
  additionalProperties: false,
};

const UNION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "text" }, value: { type: "string", maxLength: 8 } },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "count" }, value: { type: "integer", minimum: 0, maximum: 9 } },
      required: ["kind", "value"],
      additionalProperties: false,
    },
  ],
  discriminator: { propertyName: "kind" },
};

describe("closed provider schema compilation", () => {
  it("rejects raw schema JSON that bypasses the trusted parser brand", () => {
    const raw = { schema: { type: "boolean" } };
    expect(() => compileClosedProviderSchema(raw as never)).toThrow(/trusted parser/);
  });

  it("rejects forged compiled handles at the runtime validation boundary", () => {
    const compiled = compile({ type: "boolean" });
    expect(() => validateClosedProviderValue({ digest: compiled.digest } as never, true)).toThrow(
      /not compiled by the host/,
    );
  });

  it("produces one canonical digest independent of schema property order", () => {
    const first = compile(INPUT_SCHEMA);
    const reordered = compile({
      additionalProperties: false,
      required: ["mode", "score"],
      properties: INPUT_SCHEMA.properties,
      type: "object",
    });
    expect(first.digest).toBe(reordered.digest);
  });

  it("gives canonical zero spellings identical const and enum semantics", () => {
    for (const keyword of ["const", "enum"] as const) {
      const positiveText = keyword === "const" ? '{"const":0}' : '{"enum":[0]}';
      const negativeText = keyword === "const" ? '{"const":-0}' : '{"enum":[-0]}';
      const positive = compileText(positiveText);
      const negative = compileText(negativeText);
      expect(negative.digest).toBe(positive.digest);
      for (const value of [0, -0]) {
        expect(validateClosedProviderValue(positive, value).valid).toBe(true);
        expect(validateClosedProviderValue(negative, value).valid).toBe(true);
      }
    }
  });

  it("returns deterministic results independent of value property order", () => {
    const compiled = compile(INPUT_SCHEMA);
    const first = validateClosedProviderValue(compiled, { mode: "fast", score: 0.5 });
    const second = validateClosedProviderValue(compiled, { score: 0.5, mode: "fast" });
    expect(first).toEqual({ valid: true, errors: [] });
    expect(second).toEqual(first);
  });

  it("does not coerce input or add defaults", () => {
    const value = { mode: "fast", score: "0.5" };
    const result = validateClosedProviderValue(compile(INPUT_SCHEMA), value);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ path: "/score", code: "type" }));
    expect(value).toEqual({ mode: "fast", score: "0.5" });
  });

  it("enforces closed objects, bounds, enums, and registered formats", () => {
    const compiled = compile(INPUT_SCHEMA);
    expect(validateClosedProviderValue(compiled, { mode: "other", score: 2 }).valid).toBe(false);
    expect(validateClosedProviderValue(compiled, { mode: "fast", score: 0.5, extra: true }).valid).toBe(false);
    expect(validateClosedProviderValue(compiled, { mode: "deep", score: 1, at: "not-a-date" }).valid).toBe(false);
  });

  it("selects exactly one declared discriminated-union branch", () => {
    const compiled = compile(UNION_SCHEMA);
    expect(validateClosedProviderValue(compiled, { kind: "text", value: "hello" }).valid).toBe(true);
    expect(validateClosedProviderValue(compiled, { kind: "count", value: 3 }).valid).toBe(true);
    const unknown = validateClosedProviderValue(compiled, { kind: "other", value: 3 });
    expect(unknown.errors).toContainEqual(expect.objectContaining({ code: "union-discriminator" }));
  });

  it("bounds reported error details for hostile values", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`field${index}`, { type: "boolean" }]),
    );
    const schema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
    const result = validateClosedProviderValue(compile(schema), {});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeLessThanOrEqual(32);
    expect(result.errors.every((error) => Buffer.byteLength(error.detail) <= 256)).toBe(true);
  });
});
