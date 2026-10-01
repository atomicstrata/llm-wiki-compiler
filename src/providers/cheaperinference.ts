/**
 * Cheaper Inference LLM provider implementation.
 *
 * Extends OpenAIProvider since Cheaper Inference exposes an OpenAI-compatible
 * API. Sets the gateway base URL and API key, and disables embeddings because
 * the gateway exposes no embeddings endpoint.
 */

import { OpenAIProvider } from "./openai.js";

/** Cheaper Inference API base URL. */
const CHEAPER_INFERENCE_BASE_URL = "https://api.cheaperinference.com/v1";

/** Cheaper Inference-backed LLM provider using the OpenAI-compatible endpoint. */
export class CheaperInferenceProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string) {
    super(model, { baseURL: CHEAPER_INFERENCE_BASE_URL, apiKey });
  }

  /** The gateway has no embeddings endpoint; fail closed rather than inheriting OpenAI semantics. */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "Cheaper Inference provider does not support embeddings in llmwiki.\n" +
      "  For semantic search, set LLMWIKI_EMBEDDING_PROVIDER=openai, anthropic, claude-agent, ollama, or orcarouter.",
    );
  }

  /** Batch embeddings are unsupported for the same reason as single embeddings. */
  override async embedBatch(_texts: string[]): Promise<number[][]> {
    await this.embed("");
    return [];
  }
}
