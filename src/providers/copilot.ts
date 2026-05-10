/**
 * GitHub Copilot LLM provider implementation.
 *
 * Uses the GitHub Copilot API (https://api.githubcopilot.com), which exposes
 * an OpenAI-compatible chat endpoint. Requires a GitHub OAuth token with
 * Copilot access — use `gh auth token` to obtain one. Classic PATs are NOT
 * supported by this endpoint.
 *
 * Note: GitHub Copilot does not expose an embeddings API. Calling embed() will
 * throw with a helpful message. For workflows that require semantic search
 * (query with chunked retrieval), use the openai provider with OPENAI_API_KEY.
 */

import { OpenAIProvider } from "./openai.js";
import { COPILOT_BASE_URL } from "../utils/constants.js";

/** GitHub Copilot-backed LLM provider using the OpenAI-compatible endpoint. */
export class CopilotProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string) {
    super(model, { baseURL: COPILOT_BASE_URL, apiKey });
  }

  /**
   * GitHub Copilot has no native embeddings API.
   * Throws an informative error directing the user to an alternative.
   */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "GitHub Copilot does not support embeddings.\n" +
      "  For semantic search (llmwiki query), switch to the OpenAI provider:\n" +
      "    export LLMWIKI_PROVIDER=openai\n" +
      "    export OPENAI_API_KEY=sk-...",
    );
  }
}
