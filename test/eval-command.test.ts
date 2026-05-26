/**
 * Tests for src/commands/eval.ts — CLI option resolution and validation.
 */

import { describe, it, expect } from "vitest";
import { parseSampleSize } from "../src/commands/eval.js";

describe("parseSampleSize", () => {
  it.each(["0", "-1", "-100"])("rejects %s (zero or negative)", (raw) => {
    expect(() => parseSampleSize(raw)).toThrow('--sample must be a positive integer');
  });

  it.each(["2.5", "1.0001", "-0.5"])("rejects %s (decimal)", (raw) => {
    expect(() => parseSampleSize(raw)).toThrow('--sample must be a positive integer');
  });

  it.each(["abc", "", "one"])("rejects %s (non-numeric string)", (raw) => {
    expect(() => parseSampleSize(raw)).toThrow('--sample must be a positive integer');
  });

  it.each([["1", 1], ["20", 20], ["100", 100]])("accepts %s → %i", (raw, expected) => {
    expect(parseSampleSize(raw)).toBe(expected);
  });

  it("includes the rejected value in the error message", () => {
    expect(() => parseSampleSize("0")).toThrow('"0"');
  });
});
