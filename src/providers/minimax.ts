/**
 * MiniMax LLM provider implementation.
 *
 * Extends OpenAIProvider since MiniMax exposes an OpenAI-compatible API.
 * Overrides only the constructor to set MiniMax's base URL and API key.
 */

import { OpenAIProvider } from "./openai.js";

/** MiniMax API base URL. */
const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/** MiniMax-backed LLM provider using the OpenAI-compatible endpoint. */
export class MiniMaxProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string) {
    super(model, { baseURL: MINIMAX_BASE_URL, apiKey });
  }

  /** MiniMax embedding support is unverified; fail closed instead of inheriting OpenAI semantics. */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "MiniMax provider does not support embeddings in llmwiki yet.\n" +
      "  For semantic search, route embeddings to another backend and keep this\n" +
      "  provider for chat: export LLMWIKI_EMBEDDING_PROVIDER=openai (or anthropic,\n" +
      "  claude-agent, ollama).",
    );
  }

  /** MiniMax batch embeddings are unsupported for the same reason as single embeddings. */
  override async embedBatch(_texts: string[]): Promise<number[][]> {
    await this.embed("");
    return [];
  }
}
