/**
 * Tests for the JSON-Schema → Zod bridge used by the Claude Agent SDK provider.
 *
 * The shape is wrapped in `z.object()` and exercised with `safeParse`, which
 * verifies the observable behaviour callers depend on: required vs optional
 * keys, enums, nested objects/arrays, and the unknown-type fallback.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../src/providers/json-schema-to-zod.js";

/** Build a validator from a JSON Schema object, mirroring the SDK tool() usage. */
function validator(schema: Record<string, unknown>) {
  return z.object(jsonSchemaToZodShape(schema));
}

describe("jsonSchemaToZodShape", () => {
  it("treats listed keys as required and the rest as optional", () => {
    const check = validator({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
    expect(check.safeParse({ a: "x" }).success).toBe(true);
    expect(check.safeParse({ b: 1 }).success).toBe(false);
  });

  it("enforces enum values", () => {
    const check = validator({
      type: "object",
      properties: { state: { enum: ["extracted", "merged"] } },
      required: ["state"],
    });
    expect(check.safeParse({ state: "merged" }).success).toBe(true);
    expect(check.safeParse({ state: "other" }).success).toBe(false);
  });

  it("validates nested object and array properties", () => {
    const check = validator({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } },
      },
      required: ["items"],
    });
    expect(check.safeParse({ items: [{ n: 1 }] }).success).toBe(true);
    expect(check.safeParse({ items: [{ n: "no" }] }).success).toBe(false);
  });

  it("falls back to an accept-anything type for unknown schemas", () => {
    const check = validator({ type: "object", properties: { x: { type: "weird" } }, required: ["x"] });
    expect(check.safeParse({ x: { anything: true } }).success).toBe(true);
  });
});
