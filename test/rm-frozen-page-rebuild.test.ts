/**
 * @file test/rm-frozen-page-rebuild.test.ts
 * @description A page kept by `llmwiki rm` because another source still owns it
 * must be rebuilt on the next compile, without the removed source's content.
 *
 * `rm` records each kept slug in `state.frozenSlugs`, the same marker compile
 * sets when it notices a deleted source. Before this, that marker was terminal:
 * `mergeExtractions` skipped a frozen slug outright and nothing ever removed a
 * slug from the set, so the page kept the removed source's prose and its
 * citations permanently. `llmwiki lint` then reported `broken-citation` at ERROR
 * severity on a page no command could repair, and deleting the page to force a
 * rebuild lost it for good — the slug that would regenerate it was frozen.
 *
 * The distinction that fixes it: a slug frozen because THIS run's extraction
 * failed is still skipped and preserved, while a slug carried in PERSISTED state
 * is a reconciliation marker and is rebuilt from whatever owners survive.
 *
 * This covers the `rm` path specifically. The owner-closure suites alongside it
 * exercise the compile-side deletion detection, which reaches the same field by
 * a different route.
 */

import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockClaudeEnv, stubCannedCompile, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("rm-frozen-rebuild");

/** Two sources that both yield one concept, so its page is genuinely shared. */
async function sharedPageProject(handle: import("./fixtures/aimock-helper.js").MockClaudeHandle) {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [{ name: "extract_concepts", arguments: { concepts: [
      { concept: "Shared Topic", summary: "s", is_new: true, tags: [], confidence: 0.9 },
    ] } }],
  });
  handle.mock.onMessage(/.*/, { content: "Body from alpha. ^[alpha.md:1-2]\n\nAnd beta. ^[beta.md:1-2]" });
  const cwd = await aimock.makeWorkspace("# Intro\n\nIntro text.\n");
  await writeFile(path.join(cwd, "sources/alpha.md"), "# Alpha\n\nAlpha source text.\n");
  await writeFile(path.join(cwd, "sources/beta.md"), "# Beta\n\nBeta source text.\n");
  return cwd;
}

/** The page body, or null when the page is absent. */
function page(cwd: string): Promise<string | null> {
  return readFile(path.join(cwd, "wiki/concepts/shared-topic.md"), "utf-8").catch(() => null);
}

/** Compile, then remove alpha.md, returning the project and its env. */
async function compiledThenRemovedAlpha(
  handle: import("./fixtures/aimock-helper.js").MockClaudeHandle,
): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
  const cwd = await sharedPageProject(handle);
  const env = mockClaudeEnv(handle);
  expectCLIExit(await runCLI(["compile"], cwd, env), 0);
  expectCLIExit(await runCLI(["rm", "alpha.md"], cwd, env), 0);
  return { cwd, env };
}

describe("a page kept by rm is rebuilt, not frozen forever", () => {
  it("drops the removed source's citation on the next compile", async () => {
    const handle = await aimock.start();
    const cwd = await sharedPageProject(handle);
    const env = mockClaudeEnv(handle);

    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    expect(await page(cwd)).toContain("alpha.md");

    expectCLIExit(await runCLI(["rm", "alpha.md"], cwd, env), 0);
    // rm keeps the page and marks it, rather than deleting a page beta still owns.
    expect(await page(cwd)).not.toBeNull();
    const state = JSON.parse(await readFile(path.join(cwd, ".llmwiki/state.json"), "utf-8"));
    expect(state.frozenSlugs).toContain("shared-topic");

    // Byte-identical sources, so only the marker can drive this recompile.
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);

    const rebuilt = await page(cwd);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toContain("alpha.md");
    // Still a real page owned by the surviving source, not an empty husk.
    expect(rebuilt).toContain("beta.md");
  }, 180_000);

  it("clears the marker, so the page is not rebuilt again on every later compile", async () => {
    const handle = await aimock.start();
    const { cwd, env } = await compiledThenRemovedAlpha(handle);
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);

    const before = handle.mock.getRequests().length;
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    // An uncleared marker would re-extract on every compile forever.
    expect(handle.mock.getRequests().length).toBe(before);
  }, 180_000);
});
