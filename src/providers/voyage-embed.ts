/**
 * Voyage embeddings helper.
 *
 * Anthropic ships no first-party embeddings endpoint, so the Claude-backed
 * providers (`anthropic` and `claude-agent`) delegate embeddings to Voyage —
 * Anthropic's recommended partner. Shared here so both providers reuse the
 * exact same request logic. Requires the VOYAGE_API_KEY environment variable.
 */

import { EMBEDDING_MODELS } from "../utils/constants.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

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
  const apiKey = process.env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Anthropic embeddings use Voyage — set VOYAGE_API_KEY to enable semantic search.",
    );
  }

  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Voyage embeddings request failed (${response.status}): ${detail}`);
  }

  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("Voyage embeddings response did not include a vector.");
  }
  return vector;
}
