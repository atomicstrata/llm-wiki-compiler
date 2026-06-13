/**
 * Compile integration tests for review policy.
 *
 * These use the repo's normal stubbed-provider convention: extraction and page
 * generation are deterministic, offline, and exercise the real compile
 * pipeline. The mixed-source test locks the critical source-state rule: a
 * source that feeds any held candidate is not marked compiled until approval.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { compileAndReport } from "../src/compiler/index.js";
import { listCandidates } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import reviewRejectCommand from "../src/commands/review-reject.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readStateClassified } from "../src/utils/state.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const ctx = useCompileProject({
  dirSuffix: "review-policy",
  sourceFile: "sample.md",
  sourceContent: "# Sample\n\nAlpha and Beta are related.",
});

const PAGE_BODY = "Generated page body with enough content to be valid.";

async function writeReviewConfig(hold: string[]): Promise<void> {
  await mkdir(path.join(ctx.dir, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(ctx.dir, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold, lowConfidenceThreshold: 0.5 } }),
    "utf-8",
  );
}

function stubTwoConcepts(): ReturnType<typeof vi.spyOn> {
  const extraction = JSON.stringify({
    concepts: [
      { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.2 },
      { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.9 },
    ],
  });
  const spy = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(extraction);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(PAGE_BODY);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return spy;
}

async function approveInProject(candidateId: string): Promise<void> {
  const cwd = process.cwd();
  process.chdir(ctx.dir);
  try {
    await reviewApproveCommand(candidateId);
  } finally {
    process.chdir(cwd);
  }
}

describe("compile review policy", () => {
  it("holds only pages that trip policy and defers source state for mixed sources", async () => {
    await writeReviewConfig(["low-confidence"]);
    stubTwoConcepts();

    const result = await compileAndReport(ctx.dir);
    const candidates = await listCandidates(ctx.dir);
    const { state } = await readStateClassified(ctx.dir);

    expect(result.review?.held.map((c) => c.slug)).toEqual(["alpha"]);
    expect(result.candidates).toEqual([candidates[0]?.id]);
    expect(result.pages).toEqual(["beta"]);
    expect(result.concepts).toEqual(["Alpha", "Beta"]);
    expect(candidates[0]?.reviewMode).toBe("policy");
    expect(candidates[0]?.heldReasons.map((r) => r.code)).toEqual(["low-confidence"]);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "beta.md"))).toBe(true);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(false);
    expect(state.sources["sample.md"]).toBeUndefined();
  });

  it("approval persists deferred source state and prevents unchanged re-extraction", async () => {
    await writeReviewConfig(["low-confidence"]);
    const extractSpy = stubTwoConcepts();

    const first = await compileAndReport(ctx.dir);
    await approveInProject(first.candidates![0]!);
    const second = await compileAndReport(ctx.dir);
    const { state } = await readStateClassified(ctx.dir);

    expect(state.sources["sample.md"]).toBeDefined();
    expect(second.compiled).toBe(0);
    expect(second.candidates ?? []).toEqual([]);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate or re-extract an unchanged pending candidate", async () => {
    await writeReviewConfig(["low-confidence"]);
    const extractSpy = stubTwoConcepts();

    const first = await compileAndReport(ctx.dir);
    const firstId = first.candidates![0]!;
    const second = await compileAndReport(ctx.dir);
    const candidates = await listCandidates(ctx.dir);

    expect(second.compiled).toBe(0);
    expect(second.candidates ?? []).toEqual([]);
    expect(candidates.map((c) => c.id)).toEqual([firstId]);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it("policy off preserves normal direct-write behavior", async () => {
    await writeReviewConfig([]);
    stubTwoConcepts();

    const result = await compileAndReport(ctx.dir);

    expect(result.candidates ?? []).toEqual([]);
    expect(result.review).toBeUndefined();
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(true);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "beta.md"))).toBe(true);
  });

  // Test #1: candidate id preserved across a real recompile with changed source
  it("preserves candidate id when the source changes and re-trips policy", async () => {
    await writeReviewConfig(["low-confidence"]);
    stubTwoConcepts();

    const first = await compileAndReport(ctx.dir);
    const id1 = first.candidates![0]!;

    // Mutate the source file so the content/hash changes
    await writeFile(
      path.join(ctx.dir, "sources", "sample.md"),
      "# Sample\n\nAlpha and Beta are now different content.\n",
      "utf-8",
    );
    stubTwoConcepts();
    const second = await compileAndReport(ctx.dir);

    const candidates = await listCandidates(ctx.dir);
    const alphaSlugCandidates = candidates.filter((c) => c.slug === "alpha");
    expect(alphaSlugCandidates).toHaveLength(1);
    expect(second.candidates![0]).toBe(id1);
  });

  // Test #3: reject → source re-proposes on next compile
  it("rejected candidate is re-held on next compile when source still trips policy", async () => {
    await writeReviewConfig(["low-confidence"]);
    const spy = stubTwoConcepts();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await compileAndReport(ctx.dir);
    const heldId = first.candidates![0]!;
    const cwd = process.cwd();
    process.chdir(ctx.dir);
    try {
      await reviewRejectCommand(heldId);
    } finally {
      process.chdir(cwd);
    }

    spy.mockRestore();
    stubTwoConcepts();
    const second = await compileAndReport(ctx.dir);

    const candidates = await listCandidates(ctx.dir);
    expect(second.candidates!.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.slug === "alpha" && c.reviewMode === "policy")).toBe(true);
  });

  // Test #4: direct-write reconcile (L1) — policy off + changed source removes pending candidate
  it("removes pending candidate when policy is off and source changes force a direct write", async () => {
    await writeReviewConfig(["low-confidence"]);
    stubTwoConcepts();
    await compileAndReport(ctx.dir);

    const before = await listCandidates(ctx.dir);
    expect(before.some((c) => c.slug === "alpha")).toBe(true);

    // Turn policy off AND change the source so the short-circuit is bypassed
    await writeReviewConfig([]);
    await writeFile(
      path.join(ctx.dir, "sources", "sample.md"),
      "# Sample\n\nAlpha and Beta changed content for direct write.\n",
      "utf-8",
    );
    stubTwoConcepts();
    await compileAndReport(ctx.dir);

    const after = await listCandidates(ctx.dir);
    expect(after.some((c) => c.slug === "alpha")).toBe(false);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(true);
  });

  // Test #5: --review compile produces reviewMode "forced" + manual-review-requested
  it("--review compile produces forced reviewMode with manual-review-requested reason", async () => {
    stubTwoConcepts();

    const result = await compileAndReport(ctx.dir, { review: true });

    const candidates = await listCandidates(ctx.dir);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.reviewMode).toBe("forced");
      expect(candidate.heldReasons.map((r) => r.code)).toContain("manual-review-requested");
    }
    expect(result.review?.forced.length).toBeGreaterThan(0);
  });
});

// Test #2: seed pages bypass policy (separate describe to isolate LLM stub strategy)
describe("seed pages bypass review policy", () => {
  const seedCtx = useCompileProject({ dirSuffix: "seed-policy", sourceFile: "empty.md", sourceContent: "" });

  async function writeSchemaWithSeedPage(rootDir: string): Promise<void> {
    const schema = {
      version: 1, defaultKind: "concept", kinds: {},
      seedPages: [{ title: "My Overview", kind: "overview", summary: "Top-level overview." }],
    };
    await writeFile(path.join(rootDir, ".llmwiki", "schema.json"), JSON.stringify(schema), "utf-8");
  }

  async function writeLowConfidencePolicy(rootDir: string): Promise<void> {
    await writeFile(
      path.join(rootDir, ".llmwiki", "config.json"),
      JSON.stringify({ version: 1, review: { hold: ["low-confidence"] } }),
      "utf-8",
    );
  }

  it("writes seed pages directly even when low-confidence policy is active", async () => {
    await writeSchemaWithSeedPage(seedCtx.dir);
    await writeLowConfidencePolicy(seedCtx.dir);
    const llm = await import("../src/utils/llm.js");
    vi.spyOn(llm, "callClaude").mockImplementation(async ({ tools }) => {
      if (tools && tools.length > 0) return JSON.stringify({ concepts: [] });
      return "## My Overview\n\nThis is a seed page body.\n";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await compileAndReport(seedCtx.dir);

    const seedPath = path.join(seedCtx.dir, CONCEPTS_DIR, "my-overview.md");
    expect(existsSync(seedPath)).toBe(true);
    const candidates = await listCandidates(seedCtx.dir);
    expect(candidates.some((c) => c.slug === "my-overview")).toBe(false);
  });
});
