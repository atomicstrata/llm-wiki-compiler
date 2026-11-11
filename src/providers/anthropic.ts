/**
 * Anthropic LLM provider implementation.
 *
 * Wraps the @anthropic-ai/sdk to implement the LLMProvider interface.
 * Handles complete, streaming, and tool-use calls against Claude models.
 */

import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { normalizeUsage, recordUsage, usageEnabled } from "./usage.js";
import type { LLMProvider, LLMMessage, LLMTool } from "../utils/provider.js";
import { VoyageEmbeddingProvider } from "./voyage-embed.js";

/**
 * Builds the client options for the Anthropic SDK.
 *
 * Handles optional baseURL and filters out empty values so the SDK
 * can fall back to its internal defaults when not specified.
 */
interface AnthropicProviderOptions {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
}

export function buildAnthropicClientOptions(
  options: AnthropicProviderOptions = {},
): ClientOptions {
  const trimmedBaseURL = options.baseURL?.trim();
  const trimmedApiKey = options.apiKey?.trim();
  const trimmedAuthToken = options.authToken?.trim();

  const result: ClientOptions = {};

  if (trimmedApiKey) {
    result.apiKey = trimmedApiKey;
  }
  if (trimmedAuthToken) {
    result.authToken = trimmedAuthToken;
  }

  if (!trimmedBaseURL) {
    return result;
  }

  const normalizedBaseURL =
    trimmedBaseURL.endsWith("/") && trimmedBaseURL.length > 1
      ? trimmedBaseURL.slice(0, -1)
      : trimmedBaseURL;

  result.baseURL = normalizedBaseURL;
  return result;
}


/** Anthropic-backed LLM provider using the official SDK. */
export class AnthropicProvider extends VoyageEmbeddingProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model: string, options: AnthropicProviderOptions = {}) {
    super();
    usageEnabled();
    this.model = model;
    this.client = new Anthropic(buildAnthropicClientOptions(options));
  }

  /** Send a single non-streaming completion request. */
  async complete(system: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages,
    });

    recordUsage(() => ({ provider: "anthropic", model: response.model || this.model, requestId: response._request_id, responseId: response.id, operation: "complete", usage: anthropicUsage(response.usage) }));
    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.type === "text" ? textBlock.text : "";
  }

  /** Stream a completion, invoking onToken for each text chunk. */
  async stream(
    system: string,
    messages: LLMMessage[],
    maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages,
    });

    let fullText = "";
    let streamCompleted = false;
    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullText += event.delta.text;
          onToken?.(event.delta.text);
        }
      }
      streamCompleted = true;
    } finally {
      const message = stream.currentMessage ?? stream.receivedMessages.at(-1);
      recordUsage(() => ({ provider: "anthropic", model: message?.model || this.model,
        operation: "stream", usageComplete: streamCompleted, requestId: stream.request_id ?? undefined, responseId: message?.id, usage: anthropicUsage(message?.usage) }));
    }

    return fullText;
  }

  /** Call Claude with tool definitions and return the parsed tool input as JSON. */
  async toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    maxTokens: number,
  ): Promise<string> {
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages,
      tools: anthropicTools,
      tool_choice: { type: "any" },
    });

    recordUsage(() => ({ provider: "anthropic", model: response.model || this.model, requestId: response._request_id, responseId: response.id, operation: "toolCall", usage: anthropicUsage(response.usage) }));
    const toolBlock = response.content.find((block) => block.type === "tool_use");
    if (toolBlock?.type === "tool_use") {
      return JSON.stringify(toolBlock.input);
    }

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock?.type === "text" ? textBlock.text : "";
  }
}

/** Anthropic separates cached tokens from ordinary input tokens. */
function anthropicUsage(usage: Anthropic.Usage | undefined) {
  return normalizeUsage(usage && { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens, cacheWriteTokens: usage.cache_creation_input_tokens }, true);
}
