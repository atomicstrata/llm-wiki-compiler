/**
 * @file test/workflow-parse-json-object.test.ts
 * @description Unit tests for `parseJsonObject` — the pure `--input-json` parser
 * backing the typed `workflow action run` input path.
 *
 * It returns a plain object ONLY for well-formed JSON that parses to a non-null,
 * non-array object; malformed JSON, a JSON array, and a JSON scalar/`null` all
 * return `null` (the CLI wrapper turns that into an exit-1 before the core).
 */

import { describe, it, expect } from "vitest";
import { parseJsonObject } from "../src/commands/workflow.js";

describe("parseJsonObject", () => {
  it("parses a JSON object into a record", () => {
    expect(parseJsonObject('{"count":2,"dryRun":true,"tags":["a"]}')).toEqual({
      count: 2,
      dryRun: true,
      tags: ["a"],
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonObject("{not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseJsonObject("[1,2,3]")).toBeNull();
  });

  it("returns null for a JSON scalar and for null", () => {
    expect(parseJsonObject("42")).toBeNull();
    expect(parseJsonObject('"hi"')).toBeNull();
    expect(parseJsonObject("null")).toBeNull();
  });
});
