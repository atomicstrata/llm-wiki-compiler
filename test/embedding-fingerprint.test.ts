/**
 * @file test/embedding-fingerprint.test.ts
 * @description The embedding store's invalidation key covers the whole
 * configuration, not just the model name (issue #154).
 *
 * The model name was a sound proxy for "which vectors are these" only while the
 * embedding backend was pinned to the chat provider. LLMWIKI_EMBEDDING_PROVIDER
 * broke that: the backend and its endpoint now vary independently, so two
 * configurations can tag a store identically while producing vectors that do not
 * share a space. Dimensions match, so nothing downstream notices — the store is
 * silently mixed and cosine ranking degrades into noise with no error at all.
 *
 * That is the worst available failure mode, which is why each row below is a
 * separate test rather than a spot check.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  resolveEmbeddingFingerprint,
  resolveEmbeddingModel,
  storeMatchesActiveEmbedding,
} from "../src/utils/embeddings-store.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OLLAMA_HOST",
  "OLLAMA_EMBEDDINGS_HOST",
]);

afterEach(restore);

/** The fingerprint produced by one environment, for comparing two of them. */
function fingerprintFor(env: Record<string, string | undefined>): string {
  setEnv(env);
  return resolveEmbeddingFingerprint();
}

describe("resolveEmbeddingFingerprint — separates configurations the model name conflates", () => {
  it("distinguishes cloud OpenAI from a local server answering to the same model", () => {
    const cloud = fingerprintFor({ LLMWIKI_EMBEDDING_PROVIDER: "openai" });
    const local = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
    });
    expect(cloud).not.toBe(local);
  });

  it("distinguishes two different self-hosted endpoints", () => {
    const first = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-a:8000/v1",
      LLMWIKI_EMBEDDING_MODEL: "bge-m3",
    });
    const second = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-b:8000/v1",
      LLMWIKI_EMBEDDING_MODEL: "bge-m3",
    });
    expect(first).not.toBe(second);
  });

  it("distinguishes openai from ollama when both are pinned to a model they each serve", () => {
    // nomic-embed-text is served by Ollama AND by OpenAI-compatible servers, at
    // the same dimension. Identical model tag, non-interchangeable vectors.
    const viaOpenAI = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:1234/v1",
      LLMWIKI_EMBEDDING_MODEL: "nomic-embed-text",
    });
    const viaOllama = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "ollama",
      LLMWIKI_EMBEDDING_MODEL: "nomic-embed-text",
    });
    expect(viaOpenAI).not.toBe(viaOllama);
  });

  it("treats anthropic and claude-agent as ONE backend — both embed via Voyage", () => {
    // Keying on the provider name would charge a full re-embed of the wiki for a
    // switch that changes nothing about the vectors.
    const viaAnthropic = fingerprintFor({ LLMWIKI_EMBEDDING_PROVIDER: "anthropic" });
    const viaAgent = fingerprintFor({ LLMWIKI_EMBEDDING_PROVIDER: "claude-agent" });
    expect(viaAnthropic).toBe(viaAgent);
  });

  it("is stable across repeated reads of an unchanged environment", () => {
    const env = { LLMWIKI_EMBEDDING_PROVIDER: "ollama", LLMWIKI_EMBEDDING_MODEL: "bge-m3" };
    expect(fingerprintFor(env)).toBe(fingerprintFor(env));
  });
});

describe("storeMatchesActiveEmbedding", () => {
  it("accepts a store stamped by the active configuration", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "ollama" });
    expect(storeMatchesActiveEmbedding({ fingerprint: resolveEmbeddingFingerprint() })).toBe(true);
  });

  it("rejects a store stamped by a different endpoint", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "openai", OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-a:8000/v1" });
    const stamped = resolveEmbeddingFingerprint();
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "openai", OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-b:8000/v1" });
    expect(storeMatchesActiveEmbedding({ fingerprint: stamped })).toBe(false);
  });

  it("falls back to the model name for a store written before fingerprints existed", () => {
    // Upgrading must not force every existing project into a full re-embed, so a
    // legacy store keeps the old (weaker) check until the next write stamps one.
    // Only valid with NO override active — see the block below.
    setEnv({
      LLMWIKI_PROVIDER: "anthropic",
      LLMWIKI_EMBEDDING_PROVIDER: undefined,
      LLMWIKI_EMBEDDING_MODEL: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_EMBEDDINGS_BASE_URL: undefined,
      OLLAMA_HOST: undefined,
      OLLAMA_EMBEDDINGS_HOST: undefined,
    });
    expect(storeMatchesActiveEmbedding({ model: resolveEmbeddingModel() })).toBe(true);
    expect(storeMatchesActiveEmbedding({ model: "something-else" })).toBe(false);
  });

  it("rejects an absent store", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "ollama" });
    expect(storeMatchesActiveEmbedding(null)).toBe(false);
    expect(storeMatchesActiveEmbedding(undefined)).toBe(false);
  });
});

describe("the fingerprint is opaque — it is persisted, so it must carry no secret", () => {
  // The fingerprint lands in .llmwiki/embeddings.json, a file users commit,
  // copy between machines, and attach to bug reports. An endpoint override is
  // free-form and routinely carries a credential as userinfo or a query
  // parameter, so joining it in verbatim writes that credential to disk in
  // cleartext. The value is only ever compared for equality, never read back,
  // so hashing costs nothing.
  const SECRET_ENDPOINT = "https://user:hunter2@vllm.example.com/v1?api-key=sk-secret";

  it("does not contain the endpoint, its credentials, or its host", () => {
    const fingerprint = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: SECRET_ENDPOINT,
    });
    expect(fingerprint).not.toContain("hunter2");
    expect(fingerprint).not.toContain("sk-secret");
    expect(fingerprint).not.toContain("vllm.example.com");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still separates two endpoints that differ only in their credential", () => {
    // Hashing must not collapse distinct configurations into one.
    const withSecret = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: SECRET_ENDPOINT,
    });
    const withoutSecret = fingerprintFor({
      LLMWIKI_EMBEDDING_PROVIDER: "openai",
      OPENAI_EMBEDDINGS_BASE_URL: "https://vllm.example.com/v1",
    });
    expect(withSecret).not.toBe(withoutSecret);
  });
});

describe("a legacy store under an active override — the model name is known to be insufficient", () => {
  // The model-name fallback is what protects existing projects from a forced
  // re-embed on upgrade, but it is exactly wrong when an override is active:
  // the CHANGELOG's own motivating case (hosted OpenAI repointed at a local
  // endpoint, model tag unchanged) reports as matching. Worse, a partial update
  // then mixes old and new vectors and STAMPS the result with the new
  // fingerprint, so every later check vouches for the mixed store. Rebuilding
  // is a one-time cost; laundering is permanent.
  it("rebuilds when an embedding provider is named explicitly", () => {
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "ollama", LLMWIKI_EMBEDDING_MODEL: "bge-m3" });
    expect(storeMatchesActiveEmbedding({ model: resolveEmbeddingModel() })).toBe(false);
  });

  it("rebuilds when an embeddings endpoint is overridden without naming a provider", () => {
    setEnv({
      LLMWIKI_PROVIDER: "openai",
      LLMWIKI_EMBEDDING_PROVIDER: undefined,
      OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
    });
    expect(storeMatchesActiveEmbedding({ model: resolveEmbeddingModel() })).toBe(false);
  });

  it("rebuilds when the whole OpenAI base URL is repointed", () => {
    setEnv({
      LLMWIKI_PROVIDER: "openai",
      LLMWIKI_EMBEDDING_PROVIDER: undefined,
      OPENAI_EMBEDDINGS_BASE_URL: undefined,
      OPENAI_BASE_URL: "http://localhost:8000/v1",
    });
    expect(storeMatchesActiveEmbedding({ model: resolveEmbeddingModel() })).toBe(false);
  });

  it("still honours a fingerprint when one is present, override or not", () => {
    // The rule above is a fallback for MISSING provenance, not a blanket
    // rebuild: a stamped store already answers the question exactly.
    setEnv({ LLMWIKI_EMBEDDING_PROVIDER: "openai", OPENAI_EMBEDDINGS_BASE_URL: "http://vllm-a:8000/v1" });
    expect(storeMatchesActiveEmbedding({ fingerprint: resolveEmbeddingFingerprint() })).toBe(true);
  });
});
