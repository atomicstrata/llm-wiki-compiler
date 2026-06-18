/**
 * Provider-level embedBatch integration tests.
 *
 * Covers OpenAIProvider.embedBatch (Task 11), voyageEmbedBatch +
 * AnthropicProvider/ClaudeAgentProvider delegation (Task 12), and
 * CopilotProvider.embedBatch not-supported override (Task 13).
 */

import { describe, it, expect, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { voyageEmbed, voyageEmbedBatch } from "../src/providers/voyage-embed.js";
import { CopilotProvider } from "../src/providers/copilot.js";

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

describe("voyageEmbedBatch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.VOYAGE_API_KEY; });

  it("posts array input and returns index-ordered vectors", async () => {
    process.env.VOYAGE_API_KEY = "vk";
    let body: any;
    globalThis.fetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }) };
    }) as any;
    const out = await voyageEmbedBatch(["a", "b"]);
    expect(body.input).toEqual(["a", "b"]);
    expect(out).toEqual([[1], [2]]);
  });

  it("tags HTTP failures with status for the taxonomy", async () => {
    process.env.VOYAGE_API_KEY = "vk";
    globalThis.fetch = (async () => ({ ok: false, status: 429, text: async () => "slow down" })) as any;
    await expect(voyageEmbedBatch(["a"])).rejects.toMatchObject({ status: 429 });
  });

  it("single voyageEmbed rejects an empty/non-finite vector (C1, protects the query path)", async () => {
    process.env.VOYAGE_API_KEY = "vk";
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [{ embedding: [] }] }) })) as any;
    await expect(voyageEmbed("q")).rejects.toThrow();
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [{ embedding: [NaN] }] }) })) as any;
    await expect(voyageEmbed("q")).rejects.toThrow();
  });
});

describe("CopilotProvider.embedBatch", () => {
  it("throws the not-supported error", async () => {
    const p = new CopilotProvider("gpt-4o", "ghp_test");
    await expect(p.embedBatch!(["a"])).rejects.toThrow(/does not support embeddings/i);
  });
});
