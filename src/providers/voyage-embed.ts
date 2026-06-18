/**
 * Voyage embeddings helper.
 *
 * Anthropic ships no first-party embeddings endpoint, so the Claude-backed
 * providers (`anthropic` and `claude-agent`) delegate embeddings to Voyage —
 * Anthropic's recommended partner. Shared here so both providers reuse the
 * exact same request logic. Requires the VOYAGE_API_KEY environment variable.
 */

import { EMBEDDING_MODELS } from "../utils/constants.js";
import { assertVectorValid, normalizeEmbeddingData } from "../utils/embeddings-validate.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

/** Voyage embedding mode: stored content is a document; live prompts are queries. */
export type VoyageInputType = "document" | "query";

/** Build a status-tagged error so the batch taxonomy can classify HTTP failures. */
function voyageError(status: number, detail: string): Error {
  return Object.assign(new Error(`Voyage embeddings request failed (${status}): ${detail}`), { status });
}

/** Resolve and validate the Voyage API key from the environment. */
function resolveVoyageApiKey(): string {
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Anthropic embeddings use Voyage — set VOYAGE_API_KEY to enable semantic search.",
    );
  }
  return apiKey;
}

/** Execute a POST request to the Voyage embeddings endpoint. */
async function voyagePost(input: string | string[], model: string, inputType: VoyageInputType): Promise<Response> {
  const apiKey = resolveVoyageApiKey();
  return fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input, model, input_type: inputType }),
  });
}

/**
 * Produce a single embedding vector for the given text via the Voyage API.
 *
 * @param text - The text to embed.
 * @param model - Voyage model name; defaults to the Anthropic embedding model.
 * @returns The embedding vector.
 * @throws If VOYAGE_API_KEY is unset or the Voyage request fails.
 */
export async function voyageEmbed(
  text: string,
  model: string = EMBEDDING_MODELS.anthropic,
  inputType: VoyageInputType = "document",
): Promise<number[]> {
  const response = await voyagePost(text, model, inputType);
  if (!response.ok) {
    throw voyageError(response.status, await response.text());
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  assertVectorValid(vector); // reject [], NaN, ±Infinity (spec C1) — protects the query path too
  return vector;
}

/** Embed text with the default Voyage model and an explicit input type. */
async function voyageEmbedDefault(text: string, inputType: VoyageInputType = "document"): Promise<number[]> {
  return voyageEmbed(text, undefined, inputType);
}

/**
 * Embed many texts via Voyage in one request; vectors returned in input order.
 *
 * @param texts - Texts to embed.
 * @param model - Voyage model name; defaults to the Anthropic embedding model.
 * @returns Array of embedding vectors in input order.
 * @throws Status-tagged error if the request fails (enables batch taxonomy classification).
 */
export async function voyageEmbedBatch(
  texts: string[],
  model: string = EMBEDDING_MODELS.anthropic,
  inputType: VoyageInputType = "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await voyagePost(texts, model, inputType);
  if (!response.ok) {
    throw voyageError(response.status, await response.text());
  }
  const json = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
  return normalizeEmbeddingData(json.data ?? [], texts.length);
}

/** Batch-embed texts with the default Voyage model and an explicit input type. */
async function voyageEmbedBatchDefault(
  texts: string[],
  inputType: VoyageInputType = "document",
): Promise<number[][]> {
  return voyageEmbedBatch(texts, undefined, inputType);
}

/** Shared embedding implementation for providers that delegate to Voyage. */
export abstract class VoyageEmbeddingProvider {
  /** Produce a single embedding vector via Voyage. */
  async embed(text: string, inputType: VoyageInputType = "document"): Promise<number[]> {
    return voyageEmbedDefault(text, inputType);
  }

  /** Embed many texts via Voyage in one request. */
  async embedBatch(texts: string[], inputType: VoyageInputType = "document"): Promise<number[][]> {
    return voyageEmbedBatchDefault(texts, inputType);
  }
}
