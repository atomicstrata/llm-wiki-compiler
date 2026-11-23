/**
 * @file src/utils/embedding-identity.ts
 * @description The identity of the ACTIVE embedding configuration (model name
 * and the provider/model/endpoint fingerprint) and the predicate that decides
 * whether stored vectors were produced by it. A leaf: both the whole-store
 * embedding writer and the piecewise vector store decide preservation and
 * rebuilds with these, without importing each other.
 */

import { createHash } from "node:crypto";
import {
  getActiveEmbeddingProviderName,
  hasEmbeddingConfigurationOverride,
  resolveEmbeddingBackend,
  resolveEmbeddingEndpoint,
} from "./embedding-provider.js";
import { EMBEDDING_MODELS } from "./constants.js";

/**
 * Choose the active embedding model name, defaulting to anthropic's voyage model.
 *
 * LLMWIKI_EMBEDDING_MODEL is honoured only when the effective embedding provider
 * is openai, ollama or orcarouter. Anthropic and claude-agent always
 * ignore it, even when LLMWIKI_EMBEDDING_PROVIDER names one of them explicitly:
 * both delegate to Voyage's `VoyageEmbeddingProvider.embed()`, which calls the
 * Voyage API with no model argument and so always uses the hardcoded
 * EMBEDDING_MODELS.anthropic model. Honouring a configured name here would tag
 * the store — whose model field is its invalidation key — with a model that was
 * never actually used to produce its vectors, and a changed model rebuilds the
 * entire store.
 */
export function resolveEmbeddingModel(): string {
  const providerName = getActiveEmbeddingProviderName();
  const configuredModel = process.env.LLMWIKI_EMBEDDING_MODEL?.trim();
  const honoursConfigured = ["openai", "ollama", "orcarouter"].includes(providerName);
  if (configuredModel && honoursConfigured) {
    return configuredModel;
  }
  return EMBEDDING_MODELS[providerName] ?? EMBEDDING_MODELS.anthropic;
}

/**
 * Identity of the configuration that PRODUCES a store's vectors: the embedding
 * provider, its model, and the endpoint serving it.
 *
 * The model name alone is not that identity. It was a sound proxy while the
 * embedding backend was pinned to the chat provider — the only pair sharing a
 * model tag was anthropic/claude-agent, which really is the same Voyage
 * backend. LLMWIKI_EMBEDDING_PROVIDER broke the proxy by making the backend
 * vary on its own, so two configurations can now tag a store identically while
 * producing vectors that do not share a space:
 *
 *  - setting or unsetting OPENAI_EMBEDDINGS_BASE_URL — both tag
 *    `text-embedding-3-small`, one is cloud OpenAI and the other is whatever a
 *    local server answers to under that alias;
 *  - moving between `openai` and `ollama` with LLMWIKI_EMBEDDING_MODEL pinned to
 *    a name both serve (`nomic-embed-text`, `bge-m3`).
 *
 * Neither changes the dimension, so nothing downstream catches it: the store is
 * silently mixed and cosine ranking degrades into noise with no error. Folding
 * provider and endpoint into the invalidation key is what makes that a clean
 * rebuild instead.
 */
export function resolveEmbeddingFingerprint(): string {
  const providerName = getActiveEmbeddingProviderName();
  // Keyed on the BACKEND, not the provider name: anthropic and claude-agent both
  // embed via Voyage, so moving between them must not trigger a rebuild.
  // NUL-separated: no env value can contain one, so no pair of distinct
  // configurations can collide by concatenation.
  const identity = [
    resolveEmbeddingBackend(providerName),
    resolveEmbeddingModel(),
    resolveEmbeddingEndpoint(providerName),
  ].join("\0");
  // HASHED because this is persisted. The endpoint component is a free-form URL
  // that routinely carries a credential as userinfo or a query parameter, and
  // .llmwiki/embeddings.json gets committed, copied between machines, and pasted
  // into bug reports. Nothing ever reads the fingerprint back — it is only
  // compared for equality — so opacity costs nothing, and `model` remains on the
  // store in cleartext for diagnostics.
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

/**
 * True when `store` was built by the ACTIVE embedding configuration, so its
 * vectors may be preserved and searched.
 *
 * A store that predates {@link resolveEmbeddingFingerprint} carries no record of
 * its provenance, leaving only the model name to compare. Forcing every existing
 * project into a full re-embed on upgrade would be a worse default than keeping
 * that weaker check until the next write stamps a fingerprint — but only while
 * nothing overrides the embedding backend or its endpoint. Under an override the
 * name is known to be ambiguous: repointing at a local OpenAI-compatible server
 * keeps the model tag identical while producing vectors from another space.
 *
 * Preserving there does not merely postpone the rebuild. A partial update mixes
 * old and new vectors and then stamps the result with the current fingerprint,
 * so the mixed store is trusted permanently by every check that follows. The
 * rebuild is a bounded one-time cost; the laundering is not recoverable.
 */
export function storeMatchesActiveEmbedding(store: Record<string, unknown> | null | undefined): boolean {
  if (!store) return false;
  if (typeof store.fingerprint === "string") return store.fingerprint === resolveEmbeddingFingerprint();
  if (hasEmbeddingConfigurationOverride()) return false;
  return store.model === resolveEmbeddingModel();
}
