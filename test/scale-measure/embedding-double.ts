/**
 * @file test/scale-measure/embedding-double.ts
 * @description The offline embedding double of measurement children: the
 * repository's existing `fetch`-preload seam (`test/fixtures/mock-embeddings.mjs`)
 * at the measured width. The REAL embedding provider code runs (Ollama's
 * OpenAI-compatible client, configured by {@link MEASURE_ENV} at an
 * unreachable loopback address); only `globalThis.fetch` answers, in process,
 * with a deterministic vector per input text: `dimensions` multiples of 1/128
 * derived from SHA-256 in counter mode, so every value is exact in float32.
 * Any request that is not an embeddings call is refused, so no network is
 * ever reached and no provider is ever paid.
 */

import { createHash } from "node:crypto";

/** The provider environment a measurement child runs under (offline chat, double-answered embeddings, no keys). */
export const MEASURE_ENV: Readonly<Record<string, string>> = {
  LLMWIKI_PROVIDER: "offline",
  LLMWIKI_EMBEDDING_PROVIDER: "ollama",
  LLMWIKI_EMBEDDING_MODEL: "measure-double",
  OLLAMA_HOST: "http://127.0.0.1:1",
  OLLAMA_EMBEDDINGS_HOST: "http://127.0.0.1:1/v1",
  LLMWIKI_BINARY_EMBEDDINGS: "",
};

/** Calls answered so far. */
export const embeddingCalls = { requests: 0, texts: 0 };

/** The deterministic vector of `text`. */
function measuredVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < dimensions; block += 1) {
    const digest = createHash("sha256").update(`${block}\u0000${text}`).digest();
    for (const byte of digest) if (vector.length < dimensions) vector.push((byte - 128) / 128);
  }
  return vector;
}

/** Answer one embeddings request body. */
function embeddingsResponse(body: { input?: unknown; model?: string }, dimensions: number): Response {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  embeddingCalls.requests += 1;
  embeddingCalls.texts += inputs.length;
  return new Response(JSON.stringify({
    object: "list", model: body.model ?? "measure-double", usage: { prompt_tokens: 1, total_tokens: 1 },
    data: inputs.map((text, index) => ({ object: "embedding", index, embedding: measuredVector(String(text), dimensions) })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * The double's own call shape. It stands in for `fetch` but deliberately has no `preconnect` (Bun declares one on
 * `typeof fetch`): it answers embeddings in process and never connects anywhere.
 */
type OfflineFetchDouble = (input: unknown, init?: { body?: unknown }) => Promise<Response>;

/** Replace `globalThis.fetch` with the double for this process. */
export function installEmbeddingDouble(dimensions: number): void {
  globalThis.fetch = (async (input: unknown, init: { body?: unknown } = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith("/embeddings")) throw new Error(`measurement children make no network calls (refused ${url})`);
    const raw = input instanceof Request ? await input.text() : String(init.body ?? "{}");
    return embeddingsResponse(JSON.parse(raw) as { input?: unknown; model?: string }, dimensions);
  }) as typeof fetch & OfflineFetchDouble;
}
