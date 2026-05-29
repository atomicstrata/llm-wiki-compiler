/**
 * Tests for src/commands/eval.ts — CLI option resolution and validation.
 * Also covers the runEval() credential guard in src/eval/index.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { parseSampleSize } from "../src/commands/eval.js";
import { runEval } from "../src/eval/index.js";

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

describe("runEval credential guard", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.LLMWIKI_PROVIDER;
  });

  it("throws a clean credential error for full suite when anthropic key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.LLMWIKI_PROVIDER = "anthropic";

    await expect(runEval("/tmp", "full", 1)).rejects.toThrow(
      "Anthropic credentials are required"
    );
  });

  it("does not throw a credential error for fast suite without credentials", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.LLMWIKI_PROVIDER = "anthropic";

    // fast suite skips the guard — it will fail on missing files, not on credentials
    await runEval("/tmp", "fast", 1).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("Anthropic credentials are required");
    });
  });
});
