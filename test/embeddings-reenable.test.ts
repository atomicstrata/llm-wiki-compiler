/**
 * @file test/embeddings-reenable.test.ts
 * @description Real compile-pipeline regressions for disabling and re-enabling
 * embedding refreshes without changing source files during recovery.
 */

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { compileAndReport } from "../src/compiler/index.js";
import { EMBEDDINGS_FILE, ENV_EMBEDDINGS } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { conceptId, readV3Store } from "./fixtures/v3-store.js";

const ctx = useCompileProject({
  dirSuffix: "embeddings-reenable",
  sourceContent: "# Alpha\n\nAlpha is documented here.",
});

interface Revision {
  summary: string;
  body: string;
}

/** Stub generation from a mutable revision so a later compile can change the page. */
function stubGeneration(revision: Revision): {
  toolCall: ReturnType<typeof vi.spyOn>;
  complete: ReturnType<typeof vi.spyOn>;
} {
  const toolCall = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async () => JSON.stringify({
    concepts: [{ concept: "Alpha", summary: revision.summary, is_new: true }],
  }));
  const complete = vi.spyOn(AnthropicProvider.prototype, "complete")
    .mockImplementation(async () => revision.body);
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { toolCall, complete };
}

/** Configure deterministic OpenAI embeddings and return the batch-call spy. */
function stubEmbeddings(): ReturnType<typeof vi.spyOn> {
  process.env.LLMWIKI_EMBEDDING_PROVIDER = "openai";
  process.env.LLMWIKI_EMBEDDING_MODEL = "test-embed";
  process.env.OPENAI_API_KEY = "test-key";
  vi.spyOn(OpenAIProvider.prototype, "embed").mockResolvedValue([0.5, 0.5]);
  return vi.spyOn(OpenAIProvider.prototype, "embedBatch")
    .mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5]));
}

afterEach(() => {
  delete process.env[ENV_EMBEDDINGS];
  delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
  delete process.env.LLMWIKI_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
});

describe("embedding refresh re-enable", () => {
  it("backfills a missing store on an unchanged compile", async () => {
    const generation = stubGeneration({ summary: "Initial summary.", body: "Initial body." });
    const embedBatch = stubEmbeddings();
    process.env[ENV_EMBEDDINGS] = "off";

    await compileAndReport(ctx.dir);
    expect(existsSync(path.join(ctx.dir, EMBEDDINGS_FILE))).toBe(false);
    expect(embedBatch).not.toHaveBeenCalled();
    const generationCalls = [generation.toolCall.mock.calls.length, generation.complete.mock.calls.length];

    delete process.env[ENV_EMBEDDINGS];
    const result = await compileAndReport(ctx.dir);
    const store = await readV3Store(ctx.dir);

    expect(result.skipped).toBeGreaterThan(0);
    expect(store?.entries.some((entry) => entry.pageId === conceptId("alpha"))).toBe(true);
    expect(embedBatch).toHaveBeenCalled();
    expect([generation.toolCall.mock.calls.length, generation.complete.mock.calls.length]).toEqual(generationCalls);
  });

  it("reconciles a page changed while refreshes were disabled", async () => {
    const revision = { summary: "Initial summary.", body: "Initial body." };
    const generation = stubGeneration(revision);
    const embedBatch = stubEmbeddings();
    await compileAndReport(ctx.dir);
    const initialStore = await readFile(path.join(ctx.dir, EMBEDDINGS_FILE), "utf-8");
    const initialHash = (await readV3Store(ctx.dir))?.entries[0]?.embeddingTextHash;
    const initialEmbedCalls = embedBatch.mock.calls.length;

    process.env[ENV_EMBEDDINGS] = "off";
    revision.summary = "Revised summary.";
    revision.body = "Revised body.";
    await writeFile(path.join(ctx.dir, "sources/sample.md"), "# Alpha\n\nRevised source.", "utf-8");
    await compileAndReport(ctx.dir);
    expect(await readFile(path.join(ctx.dir, EMBEDDINGS_FILE), "utf-8")).toBe(initialStore);
    expect(embedBatch).toHaveBeenCalledTimes(initialEmbedCalls);
    const generationCalls = generation.toolCall.mock.calls.length;

    delete process.env[ENV_EMBEDDINGS];
    const result = await compileAndReport(ctx.dir);
    const reconciledHash = (await readV3Store(ctx.dir))?.entries[0]?.embeddingTextHash;

    expect(result.skipped).toBeGreaterThan(0);
    expect(reconciledHash).not.toBe(initialHash);
    expect(embedBatch.mock.calls.length).toBeGreaterThan(initialEmbedCalls);
    expect(generation.toolCall).toHaveBeenCalledTimes(generationCalls);
  });

  it("does not rewrite a healthy store on an unchanged compile", async () => {
    stubGeneration({ summary: "Initial summary.", body: "Initial body." });
    const embedBatch = stubEmbeddings();
    await compileAndReport(ctx.dir);
    const storePath = path.join(ctx.dir, EMBEDDINGS_FILE);
    const initialStore = await readFile(storePath, "utf-8");
    const initialEmbedCalls = embedBatch.mock.calls.length;

    const result = await compileAndReport(ctx.dir);

    expect(result.skipped).toBeGreaterThan(0);
    expect(await readFile(storePath, "utf-8")).toBe(initialStore);
    expect(embedBatch).toHaveBeenCalledTimes(initialEmbedCalls);
  });
});
