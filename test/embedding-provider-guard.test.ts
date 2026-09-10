/**
 * @file test/embedding-provider-guard.test.ts
 * @description The embedding provider is validated at the DOOR (issue #154).
 *
 * `getEmbeddingProvider()` is reached from inside retrieval and from inside the
 * compile write pass, and a throw from there behaves differently on every
 * surface: `llmwiki query` exits 1, context retrieval degrades to lexical, and
 * compile swallows it, bumps the pending-embeddings attempt counter, and
 * quarantines the affected pages after five tries. A misspelled variable name
 * must not be able to cause any of that, so `ensureProviderAvailable` — which
 * every entry point already calls before doing work — owns the check.
 *
 * These tests exercise the guard, not the factory: the factory's own behaviour
 * is covered by `test/embedding-provider.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  ensureCompileProviderAvailable,
  ensureProviderAvailable,
  ProviderUnavailableError,
  UnknownProviderError,
} from "../src/utils/provider-guard.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDINGS",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDINGS_API_KEY",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "VOYAGE_API_KEY",
  "ANTHROPIC_API_KEY",
]);

afterEach(restore);

describe("ensureProviderAvailable — embedding provider override", () => {
  it("rejects a name that cannot serve embeddings, listing the valid ones", () => {
    setEnv({ LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LLMWIKI_EMBEDDING_PROVIDER: "copilot" });
    expect(() => ensureProviderAvailable()).toThrow(UnknownProviderError);
    expect(() => ensureProviderAvailable()).toThrow(/anthropic.*claude-agent.*openai.*ollama/s);
  });

  it("rejects a misspelled name instead of silently defaulting it", () => {
    // The failure this prevents: falling through to the anthropic default made
    // query report "the index was built with a different model" — a confident,
    // wrong diagnosis of what is really a typo.
    setEnv({ LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LLMWIKI_EMBEDDING_PROVIDER: "openAI" });
    expect(() => ensureProviderAvailable()).toThrow(UnknownProviderError);
  });

  it("rejects a capable provider whose credential is missing", () => {
    setEnv({ LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LLMWIKI_EMBEDDING_PROVIDER: "openai" });
    expect(() => ensureProviderAvailable()).toThrow(ProviderUnavailableError);
    expect(() => ensureProviderAvailable()).toThrow(/OPENAI_API_KEY/);
  });

  it("accepts a dedicated embeddings key", () => {
    setEnv({
      LLMWIKI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_API_KEY: "sk-embed",
    });
    expect(() => ensureProviderAvailable()).not.toThrow();
  });

  it("accepts a self-hosted endpoint with no key at all", () => {
    setEnv({
      LLMWIKI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
    });
    expect(() => ensureProviderAvailable()).not.toThrow();
  });
});

describe("ensureProviderAvailable — the default path stays soft", () => {
  it("does not require an embedding credential when the override is unset", () => {
    // Anthropic embeddings go to Voyage; a missing VOYAGE_API_KEY degrades to
    // lexical ranking and is documented as doing so. Promoting that to a hard
    // failure here would break every project relying on it.
    setEnv({ LLMWIKI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" });
    expect(() => ensureProviderAvailable()).not.toThrow();
  });

  it("still enforces the chat provider's own credential", () => {
    setEnv({ LLMWIKI_PROVIDER: "openai" });
    expect(() => ensureProviderAvailable()).toThrow(ProviderUnavailableError);
  });

  it("checks the embedding override before the chat provider", () => {
    // Both are broken; the embedding problem is the one named, so a user fixing
    // errors top-down is not told to fix the chat key first and then hit this.
    setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_PROVIDER: "minimax" });
    expect(() => ensureProviderAvailable()).toThrow(/LLMWIKI_EMBEDDING_PROVIDER/);
  });
});

describe("ensureCompileProviderAvailable — disabled refreshes", () => {
  it("accepts codex-agent without an embedding backend", () => {
    setEnv({ LLMWIKI_PROVIDER: "codex-agent", LLMWIKI_EMBEDDINGS: "off" });
    expect(() => ensureCompileProviderAvailable()).not.toThrow();
    expect(() => ensureProviderAvailable()).toThrow(/LLMWIKI_EMBEDDING_PROVIDER/);
  });

  it("honours a caller-level embeddings opt-out", () => {
    setEnv({ LLMWIKI_PROVIDER: "codex-agent" });
    expect(() => ensureCompileProviderAvailable(false)).not.toThrow();
  });

  it("still validates the chat provider", () => {
    setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDINGS: "off" });
    expect(() => ensureCompileProviderAvailable()).toThrow(/OPENAI_API_KEY/);
  });

  it("ignores an unusable embedding override only for compile", () => {
    setEnv({
      LLMWIKI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      LLMWIKI_EMBEDDING_PROVIDER: "minimax",
      LLMWIKI_EMBEDDINGS: "off",
    });
    expect(() => ensureCompileProviderAvailable()).not.toThrow();
    expect(() => ensureProviderAvailable()).toThrow(UnknownProviderError);
  });
});
