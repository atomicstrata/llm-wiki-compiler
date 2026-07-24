/**
 * Atlas Cloud LLM provider implementation.
 *
 * Atlas Cloud exposes an OpenAI-compatible chat completions API. Embeddings are
 * not wired until a compatible embedding model is verified for llmwiki.
 */

import { OpenAIProvider } from "./openai.js";
import {
  ATLASCLOUD_API_KEY_ENV_VARS,
  ATLASCLOUD_BASE_URL,
  ATLASCLOUD_BASE_URL_ENV_VARS,
} from "../utils/constants.js";

function readFirstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Resolve Atlas Cloud API key from the supported env-var aliases. */
export function resolveAtlasCloudApiKeyFromEnv(): string | undefined {
  return readFirstEnv(ATLASCLOUD_API_KEY_ENV_VARS);
}

/** Resolve Atlas Cloud OpenAI-compatible base URL from env, or use the default. */
export function resolveAtlasCloudBaseURLFromEnv(): string {
  return readFirstEnv(ATLASCLOUD_BASE_URL_ENV_VARS) ?? ATLASCLOUD_BASE_URL;
}

/** Atlas Cloud-backed LLM provider using the OpenAI-compatible endpoint. */
export class AtlasCloudProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string, baseURL = ATLASCLOUD_BASE_URL) {
    super(model, { baseURL, apiKey });
  }

  /** Atlas Cloud embedding support is unverified; fail closed instead of inheriting OpenAI semantics. */
  override async embed(_text: string): Promise<number[]> {
    throw new Error(
      "Atlas Cloud provider does not support embeddings in llmwiki yet.\n" +
      "  For semantic search, use LLMWIKI_PROVIDER=openai, anthropic, claude-agent, or ollama.",
    );
  }

  /** Atlas Cloud batch embeddings are unsupported for the same reason as single embeddings. */
  override async embedBatch(_texts: string[]): Promise<number[][]> {
    await this.embed("");
    return [];
  }
}
