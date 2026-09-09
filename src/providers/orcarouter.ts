/**
 * OrcaRouter LLM provider implementation.
 *
 * Extends OpenAIProvider since OrcaRouter exposes an OpenAI-compatible API.
 * Sets OrcaRouter's base URL and API key, and disables embeddings until
 * that integration is wired up in llmwiki.
 */

import { OpenAIProvider } from "./openai.js";

/** OrcaRouter API base URL. */
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** OrcaRouter-backed LLM provider using the OpenAI-compatible endpoint. */
export class OrcaRouterProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string) {
    super(model, { baseURL: ORCAROUTER_BASE_URL, apiKey });
  }

  /** Embeddings are not wired up in llmwiki; fail closed rather than inheriting OpenAI semantics. */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "OrcaRouter provider does not support embeddings in llmwiki yet.\n" +
      "  For semantic search, set LLMWIKI_EMBEDDING_PROVIDER=openai, anthropic, claude-agent, or ollama.",
    );
  }

  /** OrcaRouter batch embeddings are unsupported for the same reason as single embeddings. */
  override async embedBatch(_texts: string[]): Promise<number[][]> {
    await this.embed("");
    return [];
  }
}
