/**
 * Declaration-aware confidence checks over collector-produced entity pages.
 * Witnesses guard the exact threshold, declaration opt-in, scalar validity and
 * schema ownership of malformed or missing required confidence values.
 */

import { describe, expect, it } from "vitest";
import { checkDeclaredConfidence } from "../src/profile/lint-confidence.js";
import { collectConfidenceFixture, confidenceFixture } from "./fixtures/profile-confidence.js";
import type { EntityTypeDef } from "../src/profile/types.js";

describe("checkDeclaredConfidence", () => {
  it.each([[0.3, 1], [0.5, 0], [0.7, 0]])("confidence %s", async (value, count) => {
    const { page, definition } = await confidenceFixture(value);
    expect(checkDeclaredConfidence(page, definition)).toHaveLength(count);
  });

  it("preserves the low-confidence finding identity and page context", async () => {
    const { page, definition } = await confidenceFixture(0.3);
    expect(checkDeclaredConfidence(page, definition)).toEqual([{
      rule: "low-confidence",
      severity: "warning",
      file: page.filePath,
      message: "Page confidence 0.30 is below 0.5",
      entityType: "notes",
    }]);
  });

  it.each([[0, 1], [1, 0], [-1, 1], [2, 0]])("accepts unbounded numeric value %s", async (value, count) => {
    const { page, definition } = await confidenceFixture(value);
    expect(checkDeclaredConfidence(page, definition)).toHaveLength(count);
  });

  it.each([undefined, {}])("ignores undeclared confidence with fields %s", async (fields) => {
    const { pages, problems, definition } = await collectConfidenceFixture(0.3, { directory: "wiki/notes", fields });
    expect(problems).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(checkDeclaredConfidence(pages[0], definition)).toEqual([]);
  });

  it("ignores a string declaration containing numeric-looking text", async () => {
    const { pages, problems, definition } = await collectConfidenceFixture("0.3", {
      directory: "wiki/notes", fields: { confidence: { type: "string" } },
    });
    expect(problems).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0].frontmatter.confidence).toBe("0.3");
    expect(checkDeclaredConfidence(pages[0], definition)).toEqual([]);
  });

  it("does not fabricate confidence for an absent optional field", async () => {
    const { page, definition } = await confidenceFixture(undefined);
    expect(checkDeclaredConfidence(page, definition)).toEqual([]);
  });

  it.each<EntityTypeDef>([
    { directory: "wiki/notes", fields: { confidence: { type: "number", required: true } } },
    { directory: "wiki/notes", fields: { confidence: { type: "number" } }, requiredFields: ["confidence"] },
  ])("leaves required absence to the schema: %j", async (definition) => {
    const { pages, problems } = await collectConfidenceFixture(undefined, definition);
    expect(problems).toEqual([expect.objectContaining({
      kind: "field-violation", entityType: "notes",
      message: 'Required field "confidence" is missing from frontmatter.',
    })]);
    expect(pages).toHaveLength(1);
    expect(checkDeclaredConfidence(pages[0], definition)).toEqual([]);
  });

  it.each([
    ["numeric string", "0.3"], [".nan", NaN], [".inf", Infinity], ["-.inf", -Infinity],
    ["null", null], ["boolean", false], ["array", [0.3]],
  ])("leaves invalid %s to the schema", async (_label, value) => {
    const { pages, problems, definition } = await collectConfidenceFixture(value);
    expect(problems).toEqual([expect.objectContaining({
      kind: "field-violation", entityType: "notes",
      message: expect.stringMatching(/Field "confidence".*not a valid number/),
    })]);
    expect(pages).toHaveLength(1);
    expect(checkDeclaredConfidence(pages[0], definition)).toEqual([]);
  });
});
