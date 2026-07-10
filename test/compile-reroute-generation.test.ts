/**
 * @file test/compile-reroute-generation.test.ts
 * @description Integration coverage for routing compile's page GENERATION
 * through the unified planner/executor (phase 1 of the compile reroute).
 *
 * Pins three contracts of the live-write branch reroute:
 *  - a DEFAULT compile produces the same page bytes AND routes the generation
 *    write through the executor (a single journal batch is opened);
 *  - the two CANDIDATE branches (`--review` and a policy hold) are untouched:
 *    they write ONLY a candidate JSON, open NO executor batch / journal, and
 *    write NO live page;
 *  - (HIGH-A) a floor-SKIPPED page (oversized body > GENERATED_PAGE_MAX_CHARS,
 *    the compile guardrail) is
 *    ABSENT from the committed set: it is NOT in `result.pages`, IS surfaced in
 *    errors, and is NEITHER resolved (resolveLinks slug set) NOR embedded
 *    (updateEmbeddingsLockedCore page-id set).
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CONCEPTS_DIR, GENERATED_PAGE_MAX_CHARS } from "../src/utils/constants.js";
import * as journal from "../src/trust/journal.js";
import * as resolver from "../src/compiler/resolver.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { mkdir, writeFile } from "fs/promises";

const ctx = useCompileProject({
  dirSuffix: "reroute-gen",
  sourceFile: "sample.md",
  sourceContent: "# Sample\n\nAlpha and Beta are related.",
});

/** Stub extraction (two concepts) and page generation with a fixed body. */
function stubConcepts(pageBody = "Generated page body with enough content."): void {
  const extraction = JSON.stringify({
    concepts: [
      { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.9 },
      { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.9 },
    ],
  });
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(extraction);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(pageBody);
  vi.spyOn(console, "log").mockImplementation(() => {});
}

/** Write a review-hold config that holds every page (forces the candidate branch). */
async function holdEveryPage(): Promise<void> {
  const dir = path.join(ctx.dir, ".llmwiki");
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify({ version: 1, review: { hold: ["all"] } });
  await writeFile(path.join(dir, "config.json"), body, "utf-8");
}

describe("compile generation routed through planner/executor", () => {
  it("default compile writes the pages via a single journal batch", async () => {
    stubConcepts();
    const openSpy = vi.spyOn(journal, "openBatch");

    const result = await compileAndReport(ctx.dir);
    const onDisk = (slug: string) => existsSync(path.join(ctx.dir, CONCEPTS_DIR, `${slug}.md`));

    expect([...result.pages].sort()).toEqual(["alpha", "beta"]);
    expect(onDisk("alpha") && onDisk("beta")).toBe(true);
    // Generation writes now flow through the executor: exactly one batch opened.
    expect(openSpy).toHaveBeenCalledTimes(1);
  });
});

describe("candidate branches stay off the executor", () => {
  it("--review writes only a candidate JSON, opens no journal batch, no live page", async () => {
    stubConcepts();
    const openSpy = vi.spyOn(journal, "openBatch");

    const result = await compileAndReport(ctx.dir, { review: true });

    const candidates = await listCandidates(ctx.dir);
    expect(candidates.length).toBeGreaterThan(0);
    expect(result.review?.forced.length).toBeGreaterThan(0);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(false);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "beta.md"))).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a policy-held page writes only a candidate JSON, opens no journal batch", async () => {
    await holdEveryPage();
    stubConcepts();
    const openSpy = vi.spyOn(journal, "openBatch");

    const result = await compileAndReport(ctx.dir);

    expect(result.review?.held.length).toBe(2);
    expect((result.pages ?? []).length).toBe(0);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("HIGH-A: floor-skipped page absent from committed set", () => {
  it("keeps an oversized page out of pages, resolve, and embed; records an error", async () => {
    // Body exceeds the COMPILE guardrail (GENERATED_PAGE_MAX_CHARS, the larger
    // merged-page cap) → the planner blocks the page. NOTE: compile pages get the
    // generated cap, not the single-source MAX_SOURCE_CHARS, so the skip threshold
    // is the larger guardrail.
    stubConcepts("z".repeat(GENERATED_PAGE_MAX_CHARS + 1));
    // resolveLinks now COMPUTES rewrites (returns CompilePageWrite[]); the stub
    // returns an empty plan so finalizeWiki's resolution batch is a no-op.
    const resolveSpy = vi.spyOn(resolver, "resolveLinks").mockResolvedValue([]);
    const embedSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockResolvedValue({ embedded: [], eligible: [] });

    const result = await compileAndReport(ctx.dir);

    // Both pages are oversized → both skipped: none committed.
    expect(result.pages).toEqual([]);
    expect(result.errors.some((e) => /floor:/.test(e))).toBe(true);
    expect(existsSync(path.join(ctx.dir, CONCEPTS_DIR, "alpha.md"))).toBe(false);

    const resolvedSlugs = resolveSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(resolvedSlugs).not.toContain("alpha");
    expect(resolvedSlugs).not.toContain("beta");

    const embeddedIds = embedSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(embeddedIds.some((id) => /alpha|beta/.test(id))).toBe(false);
  });
});
