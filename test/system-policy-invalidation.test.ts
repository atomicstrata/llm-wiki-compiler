/**
 * @file test/system-policy-invalidation.test.ts
 * @description Changing the caller policy regenerates the pages compiled under
 * the previous one, through the real compile pipeline.
 *
 * The unit tests pin the digest's arithmetic. None of them can tell whether the
 * policy is actually wired into change detection, and that is the whole feature:
 * a settled project whose sources have not changed short-circuits at "Nothing to
 * compile" long before any prompt is built. The control that matters is a SECOND
 * compile over byte-identical sources.
 *
 * Pending review candidates are the second surface. Deduplication compares a
 * candidate's source hash and the selection it was generated under, so a
 * candidate written under one policy must not satisfy a run asking for another.
 */

import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWiki } from "../src/sdk/wiki.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Alpha", summary: "Alpha summary.", is_new: true }],
});

const ctx = useCompileProject({
  dirSuffix: "policy-invalidation",
  sourceFile: "sample.md",
  sourceContent: "# Alpha\n\nAlpha is documented here.",
});

/** Stub both LLM phases and count how many page generations ran. */
function stubCompile(): { pages: () => number } {
  let pages = 0;
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EXTRACTION);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async () => {
    pages += 1;
    return "Alpha body. ^[sample.md]";
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { pages: () => pages };
}

/** The modifier digest recorded in the project's state. */
async function recordedDigest(): Promise<string | undefined> {
  const raw = await readFile(path.join(ctx.dir, ".llmwiki/state.json"), "utf-8");
  return (JSON.parse(raw) as { promptModifiers?: string }).promptModifiers;
}

/**
 * Compile twice over byte-identical sources and report how many page
 * generations each run performed.
 *
 * Both runs go through the real pipeline, so the second one exercises change
 * detection rather than a stub: `second > 0` means the run was invalidated,
 * `second === 0` means it short-circuited at "Nothing to compile".
 */
async function compileTwice(
  first: Parameters<ReturnType<typeof createWiki>["compile"]>[0],
  second: Parameters<ReturnType<typeof createWiki>["compile"]>[0],
): Promise<{ first: number; second: number }> {
  const spy = stubCompile();
  const wiki = createWiki({ root: ctx.dir });
  await wiki.compile(first);
  const afterFirst = spy.pages();
  await wiki.compile(second);
  return { first: afterFirst, second: spy.pages() - afterFirst };
}

describe("changing the policy invalidates what the old one produced", () => {
  it("recompiles byte-identical sources when the policy changes", async () => {
    const runs = await compileTwice({ systemPolicy: "Policy A" }, { systemPolicy: "Policy B" });
    expect(runs.first).toBeGreaterThan(0);
    expect(runs.second).toBeGreaterThan(0);
  }, 60_000);

  it("recompiles when the policy is cleared", async () => {
    const runs = await compileTwice({ systemPolicy: "Policy A" }, {});
    expect(runs.second).toBeGreaterThan(0);
  }, 60_000);

  it("leaves a settled project alone when the policy is unchanged", async () => {
    const runs = await compileTwice({ systemPolicy: "Policy A" }, { systemPolicy: "Policy A" });
    expect(runs.second).toBe(0);
  }, 60_000);

  it("treats a blank policy as no policy, leaving a settled project alone", async () => {
    const runs = await compileTwice({}, { systemPolicy: "   " });
    expect(runs.second).toBe(0);
    expect(await recordedDigest()).toBe("");
  }, 60_000);

  it("replaces a pending candidate generated under a different policy", async () => {
    // Same source bytes, different policy: the pending candidate was produced
    // under a selection this run is not asking for, so it is not a duplicate.
    const runs = await compileTwice(
      { review: true, systemPolicy: "Policy A" },
      { review: true, systemPolicy: "Policy B" },
    );
    expect(runs.first).toBeGreaterThan(0);
    expect(runs.second).toBeGreaterThan(0);
  }, 60_000);
});
