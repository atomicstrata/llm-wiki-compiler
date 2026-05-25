/**
 * Tests for src/eval/citation-support.ts — LLM citation judge.
 *
 * Uses vi.mock to stub callClaude so no actual LLM calls are made.
 * Tests extraction, deterministic sampling, cache loading, and score aggregation.
 */

import { vi } from "vitest";
import {
  extractCitationPairs,
  selectDeterministicSample,
  evaluateCitationSupport,
} from "../src/eval/citation-support.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn().mockResolvedValue(
    JSON.stringify({ score: 2, reason: "Source fully supports the claim." }),
  ),
}));

describe("extractCitationPairs", () => {
  const env = useLintTempRoot("eval-citsup-extract");

  it("returns empty array for a wiki with no pages", async () => {
    const pairs = await extractCitationPairs(env.dir);
    expect(pairs).toHaveLength(0);
  });

  it("extracts a claim and source span from a cited paragraph", async () => {
    await env.writeSource("ref.md", "Line 1\nLine 2\nLine 3\nLine 4\n");
    await env.writeConcept(
      "concept-a",
      `---\ntitle: Concept A\nsources: [ref.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim is backed by the source.^[ref.md:1-3]\n`,
    );

    const pairs = await extractCitationPairs(env.dir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].pageSlug).toBe("concept-a");
    expect(pairs[0].citedFile).toBe("ref.md");
    expect(pairs[0].claimText).toContain("This claim is backed by the source");
    expect(pairs[0].spanText).toContain("Line 1");
    expect(pairs[0].claimHash).toHaveLength(16);
  });

  it("skips citations whose source file does not exist", async () => {
    await env.writeConcept(
      "concept-b",
      `---\ntitle: Concept B\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim references a ghost source.^[nonexistent.md:1-5]\n`,
    );

    const pairs = await extractCitationPairs(env.dir);
    expect(pairs).toHaveLength(0);
  });
});

describe("selectDeterministicSample", () => {
  it("returns the same pairs regardless of input order", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      claimHash: String(i).padStart(16, "0"),
      pageSlug: `page-${i}`,
      claimText: `Claim ${i}`,
      citedFile: "ref.md",
      spanText: `Span ${i}`,
      lineStart: 1,
      lineEnd: 3,
    }));

    const shuffled = [...pairs].sort(() => Math.random() - 0.5);
    const sample1 = selectDeterministicSample(pairs, 5);
    const sample2 = selectDeterministicSample(shuffled, 5);

    expect(sample1.map((p) => p.claimHash)).toEqual(sample2.map((p) => p.claimHash));
  });

  it("returns all pairs when sampleSize exceeds total count", () => {
    const pairs = [
      { claimHash: "aaaa0000aaaa0000", pageSlug: "p", claimText: "c", citedFile: "f", spanText: "s", lineStart: 1, lineEnd: 1 },
    ];
    expect(selectDeterministicSample(pairs, 20)).toHaveLength(1);
  });
});

describe("evaluateCitationSupport", () => {
  const env = useLintTempRoot("eval-citsup-full");

  it("returns null when no cited paragraphs exist", async () => {
    await env.writeConcept(
      "empty",
      `---\ntitle: Empty\nsources: []\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nNo citations here at all.\n`,
    );

    const result = await evaluateCitationSupport(env.dir, 10);
    expect(result).toBeNull();
  });

  it("calls judge and returns aggregated scores", async () => {
    await env.writeSource("src.md", "Line 1\nLine 2\nLine 3\n");
    await env.writeConcept(
      "cited",
      `---\ntitle: Cited\nsources: [src.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim is backed by the source text.^[src.md:1-3]\n`,
    );

    const result = await evaluateCitationSupport(env.dir, 10);
    expect(result).not.toBeNull();
    expect(result!.sampledCount).toBe(1);
    expect(result!.meanScore).toBe(2);
    expect(result!.fullySupported).toBe(1);
    expect(result!.unsupported).toBe(0);
  });

  it("includes judgeErrors: 0 in result when all calls succeed", async () => {
    await env.writeSource("ok.md", "Line 1\nLine 2\n");
    await env.writeConcept(
      "no-errors",
      `---\ntitle: No Errors\nsources: [ok.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim is fully supported.^[ok.md:1-2]\n`,
    );

    const result = await evaluateCitationSupport(env.dir, 10);
    expect(result!.judgeErrors).toBe(0);
  });

  it("records judgeErrors when some but not all judge calls fail", async () => {
    const { callClaude } = await import("../src/utils/llm.js");
    const spy = vi.mocked(callClaude);
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error("temporary timeout"));

    await env.writeSource("src.md", "Line 1\nLine 2\n");
    await env.writeConcept(
      "partial-fail",
      `---\ntitle: Partial Fail\nsources: [src.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nFirst claim.^[src.md:1-1]\n\nSecond claim.^[src.md:2-2]\n`,
    );

    const result = await evaluateCitationSupport(env.dir, 10);
    expect(result).not.toBeNull();
    expect(result!.judgeErrors).toBe(1);
    expect(result!.sampledCount).toBe(1);
  });

  it("throws when every judge call fails and nothing is cached", async () => {
    const { callClaude } = await import("../src/utils/llm.js");
    const spy = vi.mocked(callClaude);
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY not set"));

    await env.writeSource("src.md", "Line 1\n");
    await env.writeConcept(
      "all-fail",
      `---\ntitle: All Fail\nsources: [src.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim will trigger a failing judge call.^[src.md:1-1]\n`,
    );

    await expect(evaluateCitationSupport(env.dir, 10)).rejects.toThrow("ANTHROPIC_API_KEY not set");
  });

  it("throws when every new judge call fails even if the cache has entries", async () => {
    const { callClaude } = await import("../src/utils/llm.js");
    const spy = vi.mocked(callClaude);

    await env.writeSource("src.md", "Line 1\nLine 2\n");
    await env.writeConcept(
      "warm-cache",
      `---\ntitle: Warm Cache\nsources: [src.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim will be cached.^[src.md:1-1]\n`,
    );

    // First run — populates the cache for pair 1
    spy.mockClear();
    await evaluateCitationSupport(env.dir, 10);

    // Add a second concept with a new uncached pair, then make the judge reject
    await env.writeConcept(
      "new-uncached",
      `---\ntitle: New Uncached\nsources: [src.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis claim is not yet cached.^[src.md:2-2]\n`,
    );
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error("ANTHROPIC_API_KEY not set"));

    // pair 1 served from cache, pair 2 fails — all new calls failed → must throw
    await expect(evaluateCitationSupport(env.dir, 10)).rejects.toThrow("ANTHROPIC_API_KEY not set");
  });

  it("skips already-cached pairs and does not call judge again", async () => {
    const { callClaude } = await import("../src/utils/llm.js");
    const spy = vi.mocked(callClaude);
    spy.mockClear();

    await env.writeSource("src2.md", "Content here.\n");
    await env.writeConcept(
      "cached",
      `---\ntitle: Cached\nsources: [src2.md]\nsummary: A concept.\ncreatedAt: 2024-01-01\nupdatedAt: 2024-01-01\n---\n\nThis is a cached claim that references the source.^[src2.md:1-1]\n`,
    );

    // First run — populates cache
    await evaluateCitationSupport(env.dir, 10);
    const callsAfterFirst = spy.mock.calls.length;

    // Second run — should use cache, no new LLM calls
    await evaluateCitationSupport(env.dir, 10);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});
