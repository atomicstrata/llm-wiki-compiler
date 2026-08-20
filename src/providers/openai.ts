/**
 * OpenAI LLM provider implementation.
 *
 * Wraps the openai npm package to implement the LLMProvider interface.
 * Translates Anthropic-style tool schemas (input_schema) to OpenAI format (parameters).
 */

import OpenAI from "openai";
import type { LLMProvider, LLMMessage, LLMTool } from "../utils/provider.js";
import { EMBEDDING_MODELS, OPENAI_DEFAULT_TIMEOUT_MS } from "../utils/constants.js";
import * as output from "../utils/output.js";
import { assertVectorValid, normalizeEmbeddingData } from "../utils/embeddings-validate.js";
import { reasoningParams, tokenLimitParams } from "./openai-request.js";

/** Construction options for an OpenAI-compatible provider. */
interface OpenAIProviderOptions {
  baseURL?: string;
  apiKey?: string;
  embeddingsBaseURL?: string;
  /**
   * Credential for the EMBEDDINGS endpoint, when it differs from the chat one.
   * Without this the embeddings client reuses `apiKey`/OPENAI_API_KEY, which
   * sends the cloud OpenAI key to whatever host `embeddingsBaseURL` names.
   */
  embeddingsApiKey?: string;
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

/** Endpoints already warned about, so a per-call provider build stays quiet. */
const warnedForwardedKeyHosts = new Set<string>();

/** True when `url`'s host is this machine — a forwarded key never leaves it. */
function isLoopbackEndpoint(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false; // unparseable → treat as remote and warn (fail loud, not silent)
  }
}

/** Stands in for a credential removed from a URL before it is printed. */
const REDACTED = "***";

/**
 * `url` with any embedded credential removed: userinfo replaced, and every query
 * value replaced while its NAME is kept so the endpoint stays recognisable.
 *
 * An endpoint override is free-form, and both `https://user:pass@host/v1` and
 * `https://host/v1?api-key=...` are ordinary ways to carry one. A warning whose
 * whole purpose is to report a credential disclosure must not create a second
 * one by pasting that URL into the terminal, CI logs, and pasted bug reports.
 */
function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    const hasUserinfo = parsed.username !== "" || parsed.password !== "";
    parsed.username = "";
    parsed.password = "";
    for (const name of [...parsed.searchParams.keys()]) parsed.searchParams.set(name, REDACTED);
    const rendered = parsed.toString();
    return hasUserinfo ? rendered.replace("//", `//${REDACTED}@`) : rendered;
  } catch {
    // Unparseable: the credential cannot be located, so drop the two places it
    // is normally carried rather than echoing a string we cannot reason about.
    return url.replace(/\/\/[^/@]*@/, `//${REDACTED}@`).replace(/\?.*$/, `?${REDACTED}`);
  }
}

/**
 * Warn ONCE that the chat API key is being sent to a separate embeddings host.
 *
 * Silent credential forwarding is the failure mode here: nothing in the config
 * says "OPENAI_API_KEY will also be sent to this other operator", and the fix
 * (OPENAI_EMBEDDINGS_API_KEY) is invisible unless named. Also flags plaintext
 * http to a remote host, which puts both the key and the wiki text on the wire.
 */
function warnForwardedKey(embeddingsBaseURL: string): void {
  if (isLoopbackEndpoint(embeddingsBaseURL) || warnedForwardedKeyHosts.has(embeddingsBaseURL)) return;
  // Dedupe on the RAW url — two endpoints differing only in their credential are
  // different destinations and each deserves its own warning.
  warnedForwardedKeyHosts.add(embeddingsBaseURL);
  output.status(
    "!",
    output.warn(
      `Sending OPENAI_API_KEY to the embeddings endpoint ${redactUrlCredentials(embeddingsBaseURL)}. ` +
      `Set OPENAI_EMBEDDINGS_API_KEY to use a different credential there.` +
      (embeddingsBaseURL.startsWith("http://") ? " That endpoint is plaintext http." : ""),
    ),
  );
}

/** Test-only hook: clear the warned-endpoint cache so each test sees a fresh warning. */
export function resetForwardedKeyWarnings(): void {
  warnedForwardedKeyHosts.clear();
}

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
    this.embeddingsClient = this.buildEmbeddingsClient(options, resolvedKey, timeout);
  }

  /**
   * The client serving embeddings: the chat client itself, unless a separate
   * endpoint OR a separate credential is configured.
   *
   * Keying this on the endpoint alone silently discarded `embeddingsApiKey`,
   * which the provider guard accepts on its own. Embeddings then authenticated
   * as the chat client — i.e. as PLACEHOLDER_API_KEY when no chat key was set —
   * so validation passed and the failure resurfaced much later as a 401 from
   * inside the embed call.
   */
  private buildEmbeddingsClient(options: OpenAIProviderOptions, chatKey: string, timeout: number): OpenAI {
    if (!options.embeddingsBaseURL && !options.embeddingsApiKey) return this.client;
    return new OpenAI({
      apiKey: this.resolveEmbeddingsKey(options, chatKey),
      // Falls back to the chat base URL: when only the credential differs, the
      // endpoint is unchanged.
      baseURL: options.embeddingsBaseURL ?? options.baseURL ?? null,
      timeout,
    });
  }

  /**
   * Credential for the embeddings client: the dedicated key when set, otherwise
   * the chat key — which is FORWARDED to a third-party host and warned about.
   *
   * Kept as forwarding rather than a hard split so existing setups that point
   * OPENAI_EMBEDDINGS_BASE_URL at a hosted OpenAI-compatible service keep
   * working. The warning is the point: sending a cloud key to another operator's
   * endpoint should be a decision, not a silent default. Loopback is exempt —
   * a key going to your own machine is not a disclosure.
   */
  private resolveEmbeddingsKey(options: OpenAIProviderOptions, chatKey: string): string {
    if (options.embeddingsApiKey) return options.embeddingsApiKey;
    // Only a separate ENDPOINT can forward the key to another operator. A
    // dedicated key with no endpoint returns above, so there is nothing to warn
    // about — and nothing to assert a base URL on.
    if (options.embeddingsBaseURL && chatKey !== PLACEHOLDER_API_KEY) warnForwardedKey(options.embeddingsBaseURL);
    return chatKey;
  }

  /** Send a single non-streaming completion request. */
  async complete(system: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
    const response = await this.client.chat.completions.create({
      ...this.requestBase(system, messages, maxTokens),
    });

    return response.choices[0]?.message?.content ?? "";
  }

  /**
   * The request fields every completion shares, with the token limit spelled
   * the way this model accepts it and `reasoning_effort` attached when the
   * project configured one. Kept in one place so the three call sites below
   * cannot drift apart.
   */
  private requestBase(
    system: string,
    messages: LLMMessage[],
    maxTokens: number,
  ): OpenAI.ChatCompletionCreateParamsNonStreaming {
    return {
      model: this.model,
      ...tokenLimitParams(this.model, maxTokens),
      ...reasoningParams(this.model),
      messages: [{ role: "system", content: system }, ...messages],
    };
  }

  /** Stream a completion, invoking onToken for each text chunk. */
  async stream(
    system: string,
    messages: LLMMessage[],
    maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const stream = await this.client.chat.completions.create({
      ...this.requestBase(system, messages, maxTokens),
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
      ...this.requestBase(system, messages, maxTokens),
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
