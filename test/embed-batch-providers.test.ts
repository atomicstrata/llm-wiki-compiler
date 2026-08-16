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
import { MiniMaxProvider } from "../src/providers/minimax.js";
import { OrcaRouterProvider } from "../src/providers/orcarouter.js";

// Build a provider and stub its embeddingsClient.embeddings.create.
function providerWithEmbeddings(create: (args: unknown) => unknown): OpenAIProvider {
  const p = new OpenAIProvider("gpt-4o", { apiKey: "test" });
  // @ts-expect-error test seam: override the private embeddings client
  p.embeddingsClient = { embeddings: { create } };
  return p;
}

function mockVoyageSuccess(json: unknown): () => any {
  let body: any;
  globalThis.fetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => json };
  }) as any;
  return () => body;
}

describe("OpenAIProvider.embedBatch", () => {
  it("sends array input and returns vectors in index order", async () => {
    let sentInput: unknown;
    let sentEncoding: unknown;
    const p = providerWithEmbeddings(async (args: any) => {
      sentInput = args.input;
      sentEncoding = args.encoding_format;
      return { data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] };
    });
    const out = await p.embedBatch!(["a", "b"]);
    expect(sentInput).toEqual(["a", "b"]);
    expect(sentEncoding).toBe("float");
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
    const readBody = mockVoyageSuccess({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] });
    const out = await voyageEmbedBatch(["a", "b"]);
    const body = readBody();
    expect(body.input).toEqual(["a", "b"]);
    expect(body.input_type).toBe("document");
    expect(out).toEqual([[1], [2]]);
  });

  it("posts query input_type for query embeddings", async () => {
    process.env.VOYAGE_API_KEY = "vk";
    const readBody = mockVoyageSuccess({ data: [{ embedding: [1] }] });
    const out = await (voyageEmbed as any)("question", undefined, "query");
    const body = readBody();
    expect(body.input_type).toBe("query");
    expect(out).toEqual([1]);
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

describe("providers without an embeddings endpoint", () => {
  it.each<[string, () => OpenAIProvider, RegExp]>([
    ["MiniMax", () => new MiniMaxProvider("MiniMax-M2.7", "test-key"), /MiniMax.*does not support embeddings/i],
    ["OrcaRouter", () => new OrcaRouterProvider("openai/gpt-4o-mini", "test-key"), /OrcaRouter.*does not support embeddings/i],
  ])("%s throws explicit unsupported errors instead of inheriting OpenAI embeddings", async (_name, make, message) => {
    const p = make();
    Reflect.set(p, "embeddingsClient", {
      embeddings: { create: async () => ({ data: [{ embedding: [1] }] }) },
    });

    await expect(p.embed("a")).rejects.toThrow(message);
    await expect(p.embedBatch!(["a"])).rejects.toThrow(message);
  });
});
