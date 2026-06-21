/**
 * OpenAI LLM provider implementation.
 *
 * Wraps the openai npm package to implement the LLMProvider interface.
 * Translates Anthropic-style tool schemas (input_schema) to OpenAI format (parameters).
 */

import OpenAI from "openai";
import type { LLMProvider, LLMMessage, LLMTool } from "../utils/provider.js";
import { EMBEDDING_MODELS, OPENAI_DEFAULT_TIMEOUT_MS } from "../utils/constants.js";
import { assertVectorValid, normalizeEmbeddingData } from "../utils/embeddings-validate.js";

/** Construction options for an OpenAI-compatible provider. */
interface OpenAIProviderOptions {
  baseURL?: string;
  apiKey?: string;
  embeddingsBaseURL?: string;
  embeddingModel?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to 10 minutes for cloud
   * OpenAI (matches the SDK default). Long compile-time completions on
   * slower local models can exceed this — see {@link OllamaProvider} which
   * raises the default and reads LLMWIKI_REQUEST_TIMEOUT_MS / OLLAMA_TIMEOUT_MS.
   */
  timeoutMs?: number;
}

/**
 * Read an integer-millisecond timeout from an env var. Returns undefined when
 * the env var is unset, empty, non-numeric, zero, or negative — so the caller
 * silently falls back to the next source in its resolution chain (env-var
 * typos like `OLLAMA_TIMEOUT_MS=30m` are not surfaced to the user).
 */
export function readTimeoutEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Resolve the OpenAI client timeout from LLMWIKI_REQUEST_TIMEOUT_MS, if set. */
function resolveOpenAITimeoutMs(): number | undefined {
  return readTimeoutEnv("LLMWIKI_REQUEST_TIMEOUT_MS");
}

/**
 * Placeholder passed to the OpenAI client when no real key is set. The SDK (v6+)
 * throws on a missing/empty key at construction, but real credential validation
 * is owned by `ensureProviderAvailable` (the provider guard); deferring here
 * keeps that the single source of truth. Local servers that ignore auth accept
 * any value anyway.
 */
const PLACEHOLDER_API_KEY = "llmwiki-unset";

/** Translate an Anthropic-style LLMTool to an OpenAI ChatCompletionTool. */
export function translateToolToOpenAI(
  tool: LLMTool,
): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** OpenAI-backed LLM provider. */
export class OpenAIProvider implements LLMProvider {
  protected readonly client: OpenAI;
  protected readonly embeddingsClient: OpenAI;
  protected readonly model: string;
  protected readonly configuredEmbeddingModel?: string;

  constructor(model: string, options: OpenAIProviderOptions = {}) {
    this.model = model;
    this.configuredEmbeddingModel = options.embeddingModel;
    // The OpenAI SDK (v6+) throws on a missing/empty key at construction. Real
    // credential validation is owned by the provider guard, so pass a
    // placeholder when unset to defer the check to that single source of truth.
    const resolvedKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? PLACEHOLDER_API_KEY;
    const timeout = options.timeoutMs ?? resolveOpenAITimeoutMs() ?? OPENAI_DEFAULT_TIMEOUT_MS;
    this.client = new OpenAI({
      apiKey: resolvedKey,
      baseURL: options.baseURL ?? null,
      timeout,
    });
    this.embeddingsClient = options.embeddingsBaseURL
      ? new OpenAI({ apiKey: resolvedKey, baseURL: options.embeddingsBaseURL, timeout })
      : this.client;
  }

  /** Send a single non-streaming completion request. */
  async complete(system: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
    });

    return response.choices[0]?.message?.content ?? "";
  }

  /** Stream a completion, invoking onToken for each text chunk. */
  async stream(
    system: string,
    messages: LLMMessage[],
    maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
    });

    let fullText = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        onToken?.(delta);
      }
    }

    return fullText;
  }

  /** Call the model with tool definitions and return the parsed tool input as JSON. */
  async toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    maxTokens: number,
  ): Promise<string> {
    const openaiTools = tools.map(translateToolToOpenAI);

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      tools: openaiTools,
      tool_choice: "required",
    });

    // openai v6 made tool_calls a union of function and custom calls; only the
    // function variant carries `.function`.
    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (toolCall?.type === "function") {
      return toolCall.function.arguments;
    }

    return response.choices[0]?.message?.content ?? "";
  }

  /** Produce a single embedding vector via the OpenAI embeddings API. */
  async embed(text: string): Promise<number[]> {
    const response = await this.embeddingsClient.embeddings.create({
      model: this.embeddingModel(),
      input: text,
      encoding_format: "float",
    });
    const vector = response.data[0]?.embedding;
    assertVectorValid(vector); // non-empty + finite (replaces the Array.isArray-only check)
    return vector;
  }

  /** Embed many texts in one request; vectors returned in input order. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.embeddingsClient.embeddings.create({
      model: this.embeddingModel(),
      input: texts,
      encoding_format: "float",
    });
    return normalizeEmbeddingData(response.data, texts.length);
  }

  /** Default embedding model for this provider. Subclasses may override. */
  protected embeddingModel(): string {
    return this.configuredEmbeddingModel ?? EMBEDDING_MODELS.openai;
  }
}
