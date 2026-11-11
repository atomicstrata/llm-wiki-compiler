/**
 * @file test/profile-validator-generated.test.ts
 * @description The committed standalone profile validator matches what Ajv
 * compiles from `profile.v1.schema.json` today. Generating it also checks the
 * schema against the draft 2020-12 meta-schema, under `strict`.
 */

import { describe, expect, it } from "bun:test";
import { GENERATED_VALIDATOR, profileValidatorSource } from "../scripts/generate-profile-validator.ts";

describe("profile-validator.generated.ts", () => {
  it("is what `bun scripts/generate-profile-validator.ts` writes from the current schema", async () => {
    expect(await Bun.file(GENERATED_VALIDATOR).text()).toBe(profileValidatorSource());
  });
});
