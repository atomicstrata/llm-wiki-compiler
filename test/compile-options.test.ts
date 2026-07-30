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
