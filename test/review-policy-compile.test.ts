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
    expect(candidates[0]?.heldReasons?.map((r) => r.code)).toEqual(["low-confidence"]);
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
});
