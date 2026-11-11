/**
 * The published profile JSON Schema is itself a valid draft 2020-12 schema.
 *
 * The runtime compiles `profile.v1.schema.json` with `validateSchema: false`
 * (see `src/profile/schema-validator.ts`): the schema is a bundled constant, so
 * checking it against the draft 2020-12 meta-schema in every process only
 * repeated this one check. This test is where that check lives now — an edit
 * that breaks the schema against the meta-schema fails here, as it used to fail
 * the first profile validation.
 */

import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../src/profile/schema/profile.v1.schema.json" with { type: "json" };

describe("profile.v1.schema.json", () => {
  it("is a valid draft 2020-12 schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(ajv.errors ?? null).toBeNull();
  });

  it("compiles with the meta-schema check on, as the runtime compiled it before", () => {
    expect(() => new Ajv2020({ allErrors: true, strict: true }).compile(schema)).not.toThrow();
  });
});
