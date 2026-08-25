/**
 * @file test/compile-options.test.ts
 * @description Public compile-option coverage for embedding suppression.
 */

import { describe, expect, it, vi } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Alpha", summary: "Alpha summary.", is_new: true }],
});

const ctx = useCompileProject({
  dirSuffix: "options",
  sourceFile: "sample.md",
  sourceContent: "# Alpha\n\nAlpha is documented here.",
});

/** Stub a one-concept compile and suppress terminal noise. */
function stubCompile(): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(EXTRACTION);
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue("Alpha body. ^[sample.md]");
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("compile options", () => {
  it("embeddings:false skips embedding refresh while still compiling pages", async () => {
    stubCompile();
    const embedSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockResolvedValue({ embedded: [], eligible: [] });

    const result = await createWiki({ root: ctx.dir }).compile({ embeddings: false });

    expect(result.pages).toContain("alpha");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  /** Compile with `options`, returning whether the embedding refresh ran. */
  async function compileAndWatchEmbeddings(
    options?: Parameters<ReturnType<typeof createWiki>["compile"]>[0],
  ): Promise<{ refreshed: boolean; pages: string[] }> {
    stubCompile();
    const embedSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockResolvedValue({ embedded: [], eligible: [] });
    const result = await createWiki({ root: ctx.dir }).compile(options);
    return { refreshed: embedSpy.mock.calls.length > 0, pages: result.pages };
  }

  // The negative case alone cannot distinguish "the flag works" from
  // "embeddings are broken for everyone": a build that never refreshes
  // satisfies it. The default path is what the flag promises to leave alone,
  // so these are what give the case above its meaning.
  it("still refreshes embeddings when the option is omitted", async () => {
    const run = await compileAndWatchEmbeddings();
    expect(run.pages).toContain("alpha");
    expect(run.refreshed).toBe(true);
  });

  it("still refreshes embeddings when the option is explicitly true", async () => {
    expect((await compileAndWatchEmbeddings({ embeddings: true })).refreshed).toBe(true);
  });
});
