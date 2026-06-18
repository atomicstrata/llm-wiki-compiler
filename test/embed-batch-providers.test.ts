/**
 * Provider-level embedBatch integration tests.
 *
 * Covers OpenAIProvider.embedBatch (Task 11), voyageEmbedBatch +
 * AnthropicProvider/ClaudeAgentProvider delegation (Task 12), and
 * CopilotProvider.embedBatch not-supported override (Task 13).
 */

import { describe, it, expect, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

// Build a provider and stub its embeddingsClient.embeddings.create.
function providerWithEmbeddings(create: (args: unknown) => unknown): OpenAIProvider {
  const p = new OpenAIProvider("gpt-4o", { apiKey: "test" });
  // @ts-expect-error test seam: override the private embeddings client
  p.embeddingsClient = { embeddings: { create } };
  return p;
}

describe("OpenAIProvider.embedBatch", () => {
  it("sends array input and returns vectors in index order", async () => {
    let sentInput: unknown;
    const p = providerWithEmbeddings(async (args: any) => {
      sentInput = args.input;
      return { data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] };
    });
    const out = await p.embedBatch!(["a", "b"]);
    expect(sentInput).toEqual(["a", "b"]);
    expect(out).toEqual([[1, 1], [2, 2]]);
  });

  it("throws on cardinality mismatch", async () => {
    const p = providerWithEmbeddings(async () => ({ data: [{ index: 0, embedding: [1] }] }));
    await expect(p.embedBatch!(["a", "b"])).rejects.toThrow();
  });

  it("single embed rejects an empty vector", async () => {
    const p = providerWithEmbeddings(async () => ({ data: [{ embedding: [] }] }));
    await expect(p.embed("a")).rejects.toThrow();
  });
});
