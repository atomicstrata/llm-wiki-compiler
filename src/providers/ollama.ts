/**
 * Ollama LLM provider implementation.
 *
 * Extends OpenAIProvider for embeddings and other OpenAI-compatible calls.
 * Structured tool calls use Ollama's native `/api/chat` endpoint with
 * JSON-schema `format`, derived from `OLLAMA_HOST`.
 */

import type { LLMMessage, LLMTool } from "../utils/provider.js";
import { OpenAIProvider, readTimeoutEnv } from "./openai.js";
import {
  EMBEDDING_MODELS,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_TIMEOUT_MS,
} from "../utils/constants.js";

/** Construction options for an Ollama-compatible provider. */
interface OllamaProviderOptions {
  baseURL: string;
  embeddingsBaseURL?: string;
  embeddingModel?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to 30 minutes for Ollama
   * because local models on modest hardware can take much longer than the
   * cloud-OpenAI default of 10. Override with OLLAMA_TIMEOUT_MS or the
   * provider-agnostic LLMWIKI_REQUEST_TIMEOUT_MS env var.
   */
  timeoutMs?: number;
}

/** Resolve the Ollama timeout: explicit option → OLLAMA_TIMEOUT_MS → LLMWIKI_REQUEST_TIMEOUT_MS → default. */
function resolveOllamaTimeoutMs(explicit?: number): number {
  return (
    explicit ??
    readTimeoutEnv("OLLAMA_TIMEOUT_MS") ??
    readTimeoutEnv("LLMWIKI_REQUEST_TIMEOUT_MS") ??
    OLLAMA_DEFAULT_TIMEOUT_MS
  );
}

/**
 * Strip a trailing `/v1` OpenAI-compat suffix from a URL pathname while
 * preserving any reverse-proxy prefix (e.g. `/ollama/v1` → `/ollama`).
 */
function stripOpenAiCompatSuffix(pathname: string): string {
  const normalized = pathname.replace(/\/$/, "");
  if (!normalized.endsWith("/v1")) return normalized;
  return normalized.slice(0, -"/v1".length);
}

/**
 * Derive the native Ollama REST base URL from an OpenAI-compatible base URL.
 *
 * `OLLAMA_HOST` must include `/v1` for the OpenAI-compatible client; native
 * structured output calls `POST {base}/api/chat`, keeping any path prefix.
 *
 * @param openAiCompatibleBaseUrl - Value of `OLLAMA_HOST` (e.g. `http://localhost:11434/v1`).
 * @returns Base URL without the `/v1` suffix, e.g. `http://localhost:11434`.
 * @throws When the URL is present but not parseable.
 */
export function resolveOllamaNativeHost(openAiCompatibleBaseUrl?: string): string {
  const raw = openAiCompatibleBaseUrl?.trim();
  if (!raw) {
    return resolveOllamaNativeHost(OLLAMA_DEFAULT_HOST);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid OLLAMA_HOST URL: ${raw}`);
  }
  const pathname = stripOpenAiCompatSuffix(url.pathname);
  return `${url.origin}${pathname}`;
}

/** Build the JSON body for Ollama's native structured `/api/chat` request. */
function buildNativeChatBody(
  model: string,
  system: string,
  messages: LLMMessage[],
  schema: Record<string, unknown> | undefined,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "system", content: system }, ...messages],
    format: schema,
    stream: false,
    options: { temperature: 0, num_predict: maxTokens },
  };
}

/** Read assistant content from a successful Ollama `/api/chat` JSON body. */
function readNativeChatContent(data: { message?: { content?: string } }): string {
  const content = data.message?.content;
  if (!content) {
    throw new Error("Ollama /api/chat returned no message content");
  }
  return content;
}

/** POST to Ollama `/api/chat` and return the assistant message content string. */
async function postNativeChat(
  nativeBaseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${nativeBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama /api/chat failed (${response.status}): ${detail}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return readNativeChatContent(data);
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama-backed LLM provider using native structured output for tool calls. */
export class OllamaProvider extends OpenAIProvider {
  private readonly nativeBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(model: string, options: OllamaProviderOptions) {
    const timeoutMs = resolveOllamaTimeoutMs(options.timeoutMs);
    super(model, {
      baseURL: options.baseURL,
      apiKey: "ollama",
      embeddingsBaseURL: options.embeddingsBaseURL,
      embeddingModel: options.embeddingModel,
      timeoutMs,
    });
    this.nativeBaseUrl = resolveOllamaNativeHost(options.baseURL);
    this.timeoutMs = timeoutMs;
  }

  /** Ollama ships a dedicated embedding model (nomic-embed-text). */
  protected override embeddingModel(): string {
    return this.configuredEmbeddingModel ?? EMBEDDING_MODELS.ollama;
  }

  /**
   * Structured tool call via Ollama's native `/api/chat` + JSON schema `format`.
   * Uses `OLLAMA_HOST` for the native base URL; `OLLAMA_EMBEDDINGS_HOST` is unchanged.
   */
  override async toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    maxTokens: number,
  ): Promise<string> {
    const body = buildNativeChatBody(
      this.model,
      system,
      messages,
      tools[0]?.input_schema,
      maxTokens,
    );
    return postNativeChat(this.nativeBaseUrl, body, this.timeoutMs);
  }
}
