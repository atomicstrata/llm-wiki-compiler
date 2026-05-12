/**
 * LLM provider abstraction layer.
 *
 * Defines the LLMProvider interface and a factory function that reads
 * LLMWIKI_PROVIDER and LLMWIKI_MODEL env vars to instantiate the
 * appropriate backend (Anthropic, OpenAI, Ollama, or MiniMax).
 */

import { DEFAULT_PROVIDER, PROVIDER_MODELS, OLLAMA_DEFAULT_HOST } from "./constants.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { OllamaProvider } from "../providers/ollama.js";
import { MiniMaxProvider } from "../providers/minimax.js";
import { CopilotProvider } from "../providers/copilot.js";
import {
  resolveAnthropicAuthFromEnv,
  resolveAnthropicBaseURLFromEnv,
  resolveAnthropicModelFromEnv,
} from "./claude-settings.js";

/** A single message in an LLM conversation. */
export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool definition in Anthropic-style format (used as the canonical shape). */
export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Provider-agnostic interface for LLM backends. */
export interface LLMProvider {
  complete(system: string, messages: LLMMessage[], maxTokens: number): Promise<string>;
  stream(
    system: string,
    messages: LLMMessage[],
    maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string>;
  toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    maxTokens: number,
  ): Promise<string>;
  /** Return a single embedding vector for the given text. */
  embed(text: string): Promise<number[]>;
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "ollama", "minimax", "copilot"]);

/**
 * Factory that returns the appropriate LLMProvider based on env vars.
 * Reads LLMWIKI_PROVIDER (default "anthropic") and LLMWIKI_MODEL
 * (defaults per provider from PROVIDER_MODELS).
 *
 * Direct process.env access is acceptable here as this is a system boundary.
 */
export function getProvider(): LLMProvider {
  const providerName = getProviderName();

  switch (providerName) {
    case "anthropic":
      return getAnthropicProvider();
    case "openai":
      return new OpenAIProvider(getModelForProvider("openai"), {
        baseURL: readOptionalEnv("OPENAI_BASE_URL"),
        embeddingsBaseURL: readOptionalEnv("OPENAI_EMBEDDINGS_BASE_URL"),
        embeddingModel: readOptionalEnv("LLMWIKI_EMBEDDING_MODEL"),
      });
    case "ollama":
      return new OllamaProvider(getModelForProvider("ollama"), {
        baseURL: readOptionalEnv("OLLAMA_HOST") ?? OLLAMA_DEFAULT_HOST,
        embeddingsBaseURL: readOptionalEnv("OLLAMA_EMBEDDINGS_HOST"),
        embeddingModel: readOptionalEnv("LLMWIKI_EMBEDDING_MODEL"),
      });
    case "minimax":
      return getMiniMaxProvider();
    case "copilot":
      return getCopilotProvider();
    default:
      throw new Error(`Unhandled provider: ${providerName}`);
  }
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getModelForProvider(providerName: "openai" | "ollama" | "minimax" | "copilot"): string {
  return process.env.LLMWIKI_MODEL ?? PROVIDER_MODELS[providerName];
}

function getMiniMaxProvider(): MiniMaxProvider {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MiniMax provider requires MINIMAX_API_KEY environment variable.\n" +
      '  Set it with: export MINIMAX_API_KEY=your_key',
    );
  }
  return new MiniMaxProvider(getModelForProvider("minimax"), apiKey);
}

function getCopilotProvider(): CopilotProvider {
  const apiKey = process.env.GITHUB_TOKEN;
  if (!apiKey) {
    throw new Error(
      "GitHub Copilot provider requires GITHUB_TOKEN environment variable.\n" +
      "  Run: gh auth refresh --scopes copilot\n" +
      "  Then set it with: export GITHUB_TOKEN=$(gh auth token)\n" +
      "  The token must belong to a GitHub account with an active Copilot subscription.",
    );
  }
  return new CopilotProvider(getModelForProvider("copilot"), apiKey);
}

function getAnthropicProvider(): AnthropicProvider {
  const model = resolveAnthropicModelFromEnv() ?? PROVIDER_MODELS.anthropic;
  const baseURL = resolveAnthropicBaseURLFromEnv();
  const auth = resolveAnthropicAuthFromEnv();

  return new AnthropicProvider(model, {
    baseURL,
    ...auth,
  });
}

function getProviderName(): string {
  const providerName = process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER;
  if (!SUPPORTED_PROVIDERS.has(providerName)) {
    throw new Error(
      `Unknown provider "${providerName}". Supported: ${[...SUPPORTED_PROVIDERS].join(", ")}`,
    );
  }
  return providerName;
}

/** Expose the resolved provider name for callers that need model lookup. */
export function getActiveProviderName(): string {
  return getProviderName();
}
