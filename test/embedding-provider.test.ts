/**
 * @file test/embedding-provider.test.ts
 * @description Tests for the embedding-provider factory (issue #154).
 *
 * Embeddings may be served by a different backend than chat — Claude Agent for
 * generation, a local OpenAI-compatible server for vectors. These tests pin the
 * three properties that make that safe: with LLMWIKI_EMBEDDING_PROVIDER unset
 * nothing changes, an explicitly named provider must be embedding-capable, and
 * the credential rule exempts self-hosted endpoints (which need no API key)
 * while still catching a missing key for a hosted one.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  getEmbeddingProvider,
  getActiveEmbeddingProviderName,
  isEmbeddingProviderExplicit,
} from "../src/utils/embedding-provider.js";
import { getProvider } from "../src/utils/provider.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OLLAMA_EMBEDDINGS_HOST",
  "VOYAGE_API_KEY",
  "ANTHROPIC_API_KEY",
]);

afterEach(restore);

describe("getEmbeddingProvider — default path is unchanged", () => {
  it("returns the chat provider's type when the override is unset", () => {
    setEnv({ LLMWIKI_PROVIDER: "openai", OPENAI_API_KEY: "k" });
    expect(getEmbeddingProvider()).toBeInstanceOf(getProvider().constructor as never);
    expect(isEmbeddingProviderExplicit()).toBe(false);
    expect(getActiveEmbeddingProviderName()).toBe("openai");
  });

  it("does not require VOYAGE_API_KEY on the default anthropic path", () => {
    setEnv({ LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    expect(() => getEmbeddingProvider()).not.toThrow();
  });
});

describe("getEmbeddingProvider — explicit override", () => {
  it("builds a different backend than chat (the issue's configuration)", () => {
    setEnv({
      LLMWIKI_PROVIDER: "claude-agent",
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
      LLMWIKI_EMBEDDING_MODEL: "local-embed",
    });
    const provider = getEmbeddingProvider();
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(getActiveEmbeddingProviderName()).toBe("openai");
    expect(isEmbeddingProviderExplicit()).toBe(true);
    // OllamaProvider extends OpenAIProvider, so the instanceof check above alone
    // would pass even for an Ollama provider. Assert the configured embeddings
    // base URL actually reached the constructed client (mirrors
    // test/provider-factory.test.ts's expectClientBaseURL pattern).
    expect(Reflect.get(Reflect.get(provider, "embeddingsClient"), "baseURL")).toBe("http://localhost:8000/v1");
  });

  it("accepts every embedding-capable provider", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "ollama" });
    expect(getEmbeddingProvider()).toBeInstanceOf(OllamaProvider);
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "anthropic", VOYAGE_API_KEY: "v" });
    expect(getEmbeddingProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it("rejects providers whose embed() throws, naming the valid values", () => {
    for (const name of ["copilot", "minimax", "orcarouter", "not-a-provider"]) {
      setEnv({ LLMWIKI_EMBEDDING_PROVIDER: name });
      expect(() => getEmbeddingProvider()).toThrow(/anthropic.*claude-agent.*openai.*ollama/s);
    }
  });
});

describe("getEmbeddingProvider — credential rule", () => {
  it("requires the key when the endpoint is not overridden", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "openai" });
    expect(() => getEmbeddingProvider()).toThrow(/OPENAI_API_KEY/);
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "anthropic" });
    expect(() => getEmbeddingProvider()).toThrow(/VOYAGE_API_KEY/);
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "claude-agent" });
    expect(() => getEmbeddingProvider()).toThrow(/VOYAGE_API_KEY/);
  });

  it("exempts a self-hosted endpoint from needing a key", () => {
    setEnv({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
    });
    expect(() => getEmbeddingProvider()).not.toThrow();
  });

  it("never requires a key for ollama", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "ollama" });
    expect(() => getEmbeddingProvider()).not.toThrow();
  });
});
