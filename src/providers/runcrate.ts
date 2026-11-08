/**
 * Runcrate LLM provider implementation.
 *
 * Runcrate is an AI cloud that serves open models through an OpenAI-compatible
 * chat completions API. Embeddings are not wired until a compatible embedding
 * model is verified for llmwiki, so `embed()` fails closed.
 */

import { OpenAIProvider } from "./openai.js";
import { RUNCRATE_BASE_URL } from "../utils/constants.js";

/** Runcrate-backed LLM provider using the OpenAI-compatible endpoint. */
export class RuncrateProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string) {
    super(model, { baseURL: RUNCRATE_BASE_URL, apiKey });
  }

  /** Runcrate embedding support is unverified; fail closed instead of inheriting OpenAI semantics. */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "Runcrate provider does not support embeddings in llmwiki yet.\n" +
      "  For semantic search, route embeddings to another backend and keep this\n" +
      "  provider for chat: export LLMWIKI_EMBEDDING_PROVIDER=openai (or anthropic,\n" +
      "  claude-agent, ollama).",
    );
  }

  /** Runcrate batch embeddings are unsupported for the same reason as single embeddings. */
  override async embedBatch(_texts: string[]): Promise<number[][]> {
    await this.embed("");
    return [];
  }
}
