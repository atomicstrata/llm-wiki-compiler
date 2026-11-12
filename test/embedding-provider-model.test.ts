/**
 * @file test/embedding-provider-model.test.ts
 * @description Pins resolveEmbeddingModel across every combination of chat
 * provider and LLMWIKI_EMBEDDING_PROVIDER (issue #154).
 *
 * The stored model drives store invalidation: when it changes,
 * embeddings-migrate.ts rebuilds every vector. So a wrong answer here is not a
 * cosmetic bug, it is an unrequested re-embed of the whole wiki at the user's
 * expense. An earlier draft of the rule silently stopped honouring
 * LLMWIKI_EMBEDDING_MODEL for existing openai/ollama users, which is exactly
 * that failure — hence one test per row rather than a spot check.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveEmbeddingModel } from "../src/utils/embeddings-store.js";
import { EMBEDDING_MODELS } from "../src/utils/constants.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
]);

afterEach(restore);

describe("resolveEmbeddingModel — override unset (must match today exactly)", () => {
  it("honours LLMWIKI_EMBEDDING_MODEL for openai", () => {
    setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: "custom-embed" });
    expect(resolveEmbeddingModel()).toBe("custom-embed");
  });

  it("honours LLMWIKI_EMBEDDING_MODEL for ollama", () => {
    setEnv({ LLMWIKI_PROVIDER: "ollama", LLMWIKI_EMBEDDING_MODEL: "custom-embed" });
    expect(resolveEmbeddingModel()).toBe("custom-embed");
  });

  it("ignores LLMWIKI_EMBEDDING_MODEL for anthropic and claude-agent", () => {
    setEnv({ LLMWIKI_PROVIDER: "anthropic", LLMWIKI_EMBEDDING_MODEL: "custom-embed" });
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS.anthropic);
    setEnv({ LLMWIKI_PROVIDER: "claude-agent", LLMWIKI_EMBEDDING_MODEL: "custom-embed" });
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS["claude-agent"]);
  });

  it("falls back to the anthropic model for providers with no entry", () => {
    setEnv({ LLMWIKI_PROVIDER: "minimax" });
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS.anthropic);
  });
});

describe("resolveEmbeddingModel — override set", () => {
  it("ignores LLMWIKI_EMBEDDING_MODEL for anthropic even when named explicitly", () => {
    setEnv({
      LLMWIKI_PROVIDER: "claude-agent",
      LLMWIKI_EMBEDDING_PROVIDER: "anthropic",
      LLMWIKI_EMBEDDING_MODEL: "voyage-3",
    });
    // Voyage embeds with a hardcoded model, so recording a custom name here would
    // make the store's model field — its invalidation key — describe vectors that
    // were never produced.
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS.anthropic);
  });

  it("defaults to the embedding provider's model, not the chat provider's", () => {
    setEnv({ LLMWIKI_PROVIDER: "claude-agent", LLMWIKI_EMBEDDING_PROVIDER: "openai" });
    expect(resolveEmbeddingModel()).toBe(EMBEDDING_MODELS.openai);
  });
});
