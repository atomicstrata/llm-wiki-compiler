/**
 * Unit tests for the prompt-budget helper (issue #39).
 *
 * The default-case behaviour must be byte-identical to the previous
 * unbudgeted concatenation — these tests pin that contract so future
 * refactors can't accidentally drift.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  buildBudgetedCombinedContent,
  resolvePromptBudgetChars,
  type SourceSlice,
} from "../src/compiler/prompt-budget.js";
import { DEFAULT_PROMPT_BUDGET_CHARS } from "../src/utils/constants.js";

const ENV_KEY = "LLMWIKI_PROMPT_BUDGET_CHARS";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolvePromptBudgetChars", () => {
  it("returns the default when env is unset", () => {
    expect(resolvePromptBudgetChars()).toBe(DEFAULT_PROMPT_BUDGET_CHARS);
  });

  it("honours a numeric env override", () => {
    process.env[ENV_KEY] = "50000";
    expect(resolvePromptBudgetChars()).toBe(50_000);
  });

  it("ignores non-numeric env values", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(resolvePromptBudgetChars()).toBe(DEFAULT_PROMPT_BUDGET_CHARS);
  });

  it("ignores zero or negative env values", () => {
    process.env[ENV_KEY] = "0";
    expect(resolvePromptBudgetChars()).toBe(DEFAULT_PROMPT_BUDGET_CHARS);
    process.env[ENV_KEY] = "-100";
    expect(resolvePromptBudgetChars()).toBe(DEFAULT_PROMPT_BUDGET_CHARS);
  });
});

describe("buildBudgetedCombinedContent", () => {
  it("default case: total under budget produces numbered-line concatenation", () => {
    const slices: SourceSlice[] = [
      { file: "a.md", content: "alpha content" },
      { file: "b.md", content: "beta content" },
    ];
    const out = buildBudgetedCombinedContent("Concept", slices);
    expect(out).toBe(
      "--- SOURCE: a.md ---\n\n1 | alpha content\n\n--- SOURCE: b.md ---\n\n1 | beta content",
    );
    expect(out).not.toContain("truncated");
  });

  it("line numbers are right-aligned based on total line count", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const slices: SourceSlice[] = [{ file: "multi.md", content }];
    const out = buildBudgetedCombinedContent("Concept", slices);
    expect(out).toContain(" 1 | line 1");
    expect(out).toContain("10 | line 10");
  });

  it("over-budget: each source is truncated to a fair share", () => {
    process.env[ENV_KEY] = "60"; // tiny budget to force truncation
    const slices: SourceSlice[] = [
      { file: "a.md", content: "X".repeat(100) },
      { file: "b.md", content: "Y".repeat(100) },
      { file: "c.md", content: "Z".repeat(100) },
    ];
    const out = buildBudgetedCombinedContent("Concept", slices);
    // perSource = floor(60 / 3) = 20. Each slice is trimmed to 20 chars + marker.
    expect(out).toContain("X".repeat(20));
    expect(out).toContain("Y".repeat(20));
    expect(out).toContain("Z".repeat(20));
    expect(out).not.toContain("X".repeat(21));
    expect(out).toContain("truncated");
  });

  it("over-budget: small source under per-share budget is preserved untrimmed", () => {
    process.env[ENV_KEY] = "60";
    const slices: SourceSlice[] = [
      { file: "small.md", content: "tiny" }, // 4 chars, under per-share = 30
      { file: "big.md", content: "Y".repeat(200) },
    ];
    const out = buildBudgetedCombinedContent("Concept", slices);
    // perSource = floor(60 / 2) = 30. Small source survives intact.
    expect(out).toContain("--- SOURCE: small.md ---\n\n1 | tiny");
    // Big source is truncated to 30 chars + marker.
    expect(out).toContain("Y".repeat(30));
    expect(out).not.toContain("Y".repeat(31));
  });

  it("preserves source order and section headers", () => {
    process.env[ENV_KEY] = "30";
    const slices: SourceSlice[] = [
      { file: "first.md", content: "A".repeat(50) },
      { file: "second.md", content: "B".repeat(50) },
    ];
    const out = buildBudgetedCombinedContent("Concept", slices);
    const firstIdx = out.indexOf("first.md");
    const secondIdx = out.indexOf("second.md");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("handles a single source larger than the budget without divide-by-zero", () => {
    process.env[ENV_KEY] = "20";
    const slices: SourceSlice[] = [{ file: "only.md", content: "X".repeat(500) }];
    const out = buildBudgetedCombinedContent("Concept", slices);
    expect(out).toContain("X".repeat(20));
    expect(out).not.toContain("X".repeat(21));
    expect(out).toContain("truncated");
  });

  it("empty slice list yields empty content (no crash)", () => {
    expect(buildBudgetedCombinedContent("Concept", [])).toBe("");
  });
});
