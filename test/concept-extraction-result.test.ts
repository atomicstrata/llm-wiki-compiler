/**
 * Structured extraction parsing must preserve the difference between no
 * supported concepts and an unusable provider response, including providers
 * that encode the concepts array as a JSON string.
 */
import { describe, expect, it } from "vitest";
import { parseConceptExtraction, parseConcepts } from "../src/compiler/prompts.js";

describe("concept extraction result", () => {
  it.each(['{"concepts":[]}', '{"concepts":"[]"}'])("accepts an explicit empty array: %s", raw => {
    expect(parseConceptExtraction(raw)).toEqual([]);
  });

  it.each(["null", "[]", "{}", "not JSON", '{"concepts":{}}', '{"concepts":null}', '{"concepts":[null,{}]}'])(
    "distinguishes invalid output from empty success: %s", raw => {
      expect(parseConceptExtraction(raw)).toBeUndefined();
      expect(parseConcepts(raw)).toEqual([]);
    },
  );

  it("rejects partial output instead of treating missing assignments as intentional", () => {
    const concept = { concept: "Planner", summary: "Sequences work orders.", is_new: true };
    const result = parseConceptExtraction(JSON.stringify({ concepts: [null, {}, concept] }));
    expect(result).toBeUndefined();
  });
});
