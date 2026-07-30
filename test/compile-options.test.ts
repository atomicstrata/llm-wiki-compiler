/**
 * @file test/compile-options.test.ts
 * @description Public compile-option coverage for embedding suppression and
 * caller-provided additive system policy across both LLM phases.
 */

import { describe, expect, it, vi } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const POLICY = "Never publish credential values from the supplied sources.";
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

/** Return a provider stub that records its system prompt. */
function captureSystem<T>(systems: string[], value: T): (system: string) => Promise<T> {
  return async (system) => {
    systems.push(system);
    return value;
  };
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

  it("adds one caller policy to both built-in system prompts before source material", async () => {
    const extractionSystems: string[] = [];
    const pageSystems: string[] = [];
    vi.spyOn(AnthropicProvider.prototype, "toolCall")
      .mockImplementation(captureSystem(extractionSystems, EXTRACTION));
    vi.spyOn(AnthropicProvider.prototype, "complete")
      .mockImplementation(captureSystem(pageSystems, "Alpha body. ^[sample.md]"));

    await createWiki({ root: ctx.dir }).compile({ embeddings: false, systemPolicy: POLICY });

    expect(extractionSystems[0]).toContain("You are a knowledge extraction engine.");
    expect(pageSystems[0]).toContain("You are a wiki author.");
    expect(extractionSystems[0]).toContain(POLICY);
    expect(pageSystems[0]).toContain(POLICY);
    expect(extractionSystems[0].indexOf(POLICY)).toBeLessThan(extractionSystems[0].indexOf("--- SOURCE DOCUMENT ---"));
    expect(pageSystems[0].indexOf(POLICY)).toBeLessThan(pageSystems[0].indexOf("--- SOURCE MATERIAL ---"));
  });
});
