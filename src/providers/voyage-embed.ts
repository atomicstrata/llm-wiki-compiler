/**
 * Voyage embeddings helper.
 *
 * Anthropic ships no first-party embeddings endpoint, so the Claude-backed
 * providers (`anthropic` and `claude-agent`) delegate embeddings to Voyage —
 * Anthropic's recommended partner. Shared here so both providers reuse the
 * exact same request logic. Requires the VOYAGE_API_KEY environment variable.
 */

import { EMBEDDING_MODELS } from "../utils/constants.js";
import { normalizeEmbeddingData } from "../utils/embeddings-validate.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

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
async function voyagePost(input: string | string[], model: string): Promise<Response> {
  const apiKey = resolveVoyageApiKey();
  return fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input, model }),
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
): Promise<number[]> {
  const response = await voyagePost(text, model);
  if (!response.ok) {
    throw voyageError(response.status, await response.text());
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("Voyage embeddings response did not include a vector.");
  }
  return vector;
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
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await voyagePost(texts, model);
  if (!response.ok) {
    throw voyageError(response.status, await response.text());
  }
  const json = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
  return normalizeEmbeddingData(json.data ?? [], texts.length);
}
