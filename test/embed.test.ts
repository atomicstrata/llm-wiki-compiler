/**
 * Tests for the embed() method on each provider.
 *
 * OpenAI: stub the underlying openai SDK client so we can assert the model
 * and input passed to embeddings.create().
 *
 * Anthropic: verify the missing-key error surfaces before any network call.
 */

import { describe, it, expect, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { EMBEDDING_MODELS } from "../src/utils/constants.js";

interface StubCall {
  model: string;
  input: string;
  encodingFormat?: string;
}

function stubOpenAIClient(provider: OpenAIProvider, vector: number[]): StubCall[] {
  const calls: StubCall[] = [];
  const fakeClient = makeEmbeddingStub(calls, vector);
  // The OpenAI SDK clients are protected fields; override them for testing.
  Reflect.set(provider, "client", fakeClient);
  Reflect.set(provider, "embeddingsClient", fakeClient);
  return calls;
}

function stubSplitClients(provider: OpenAIProvider): { chatCalls: StubCall[]; embedCalls: StubCall[] } {
  const chatCalls: StubCall[] = [];
  const embedCalls: StubCall[] = [];
  Reflect.set(provider, "client", makeEmbeddingStub(chatCalls, [9]));
  Reflect.set(provider, "embeddingsClient", makeEmbeddingStub(embedCalls, [1, 2, 3]));
  return { chatCalls, embedCalls };
}

function makeEmbeddingStub(calls: StubCall[], vector: number[]): unknown {
  return {
    embeddings: {
      create: async ({ model, input, encoding_format }: { model: string; input: string; encoding_format?: string }) => {
        const call: StubCall = { model, input };
        if (encoding_format) call.encodingFormat = encoding_format;
        calls.push(call);
        return { data: [{ embedding: vector }] };
      },
    },
  };
}

describe("OpenAIProvider.embed", () => {
  it("calls the embeddings API with text-embedding-3-small and returns the vector", async () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test-key" });
    const expected = [0.1, 0.2, 0.3];
    const calls = stubOpenAIClient(provider, expected);

    const result = await provider.embed("hello world");

    expect(result).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(EMBEDDING_MODELS.openai);
    expect(calls[0].input).toBe("hello world");
    expect(calls[0].encodingFormat).toBe("float");
  });

  it("reuses the primary client when no embeddings URL is configured", () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test-key" });
    expect(Reflect.get(provider, "embeddingsClient")).toBe(Reflect.get(provider, "client"));
  });

  it("uses a separate embeddings client when an embeddings URL is configured", async () => {
    const provider = new OpenAIProvider("gpt-4o", {
      apiKey: "test-key",
      embeddingsBaseURL: "http://localhost:8081/v1",
    });
    const { chatCalls, embedCalls } = stubSplitClients(provider);

    const result = await provider.embed("separate endpoint");

    expect(result).toEqual([1, 2, 3]);
    expect(chatCalls).toEqual([]);
    expect(embedCalls).toEqual([
      { model: EMBEDDING_MODELS.openai, input: "separate endpoint", encodingFormat: "float" },
    ]);
  });

  it("uses a configured embedding model when provided", async () => {
    const provider = new OpenAIProvider("gpt-4o", {
      apiKey: "test-key",
      embeddingModel: "local-embed",
    });
    const calls = stubOpenAIClient(provider, [0.4]);

    await provider.embed("custom model");

    expect(calls[0].model).toBe("local-embed");
  });

  it("throws a clear error when the response is missing a vector", async () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test-key" });
    Reflect.set(provider, "embeddingsClient", {
      embeddings: {
        create: async () => ({ data: [] }),
      },
    });

    await expect(provider.embed("anything")).rejects.toThrow();
  });
});

describe("AnthropicProvider.embed", () => {
  const SAVED_KEY = process.env.VOYAGE_API_KEY;

  afterEach(() => {
    if (SAVED_KEY === undefined) {
      delete process.env.VOYAGE_API_KEY;
    } else {
      process.env.VOYAGE_API_KEY = SAVED_KEY;
    }
  });

  it("throws a clear error when VOYAGE_API_KEY is missing", async () => {
    delete process.env.VOYAGE_API_KEY;
    const provider = new AnthropicProvider("claude-sonnet-4-6", { apiKey: "sk-test" });
    await expect(provider.embed("hello")).rejects.toThrow(/VOYAGE_API_KEY is not set/);
  });

  it("throws a clear error when VOYAGE_API_KEY is whitespace", async () => {
    process.env.VOYAGE_API_KEY = "   ";
    const provider = new AnthropicProvider("claude-sonnet-4-6", { apiKey: "sk-test" });
    await expect(provider.embed("hello")).rejects.toThrow(/VOYAGE_API_KEY is not set/);
  });
});
