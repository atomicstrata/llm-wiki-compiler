/**
 * Claude Agent SDK LLM provider implementation.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` to implement the
 * LLMProvider interface. Unlike the `anthropic` provider (which calls the raw
 * Messages API), this backend routes through the Agent SDK and therefore
 * authenticates with the user's local Claude Code login (OAuth/subscription) —
 * no standalone ANTHROPIC_API_KEY is required.
 *
 * Generation runs in single-shot mode (one turn, no agentic file tools) so it
 * behaves like a plain completion. Structured output (`toolCall`) is handled
 * faithfully by registering the requested tool as an in-process SDK MCP tool
 * and capturing the model's `tool_use` input. Embeddings delegate to Voyage,
 * mirroring the `anthropic` provider.
 */

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { LLMProvider, LLMMessage, LLMTool } from "../utils/provider.js";
import { voyageEmbed, voyageEmbedBatch } from "./voyage-embed.js";
import { jsonSchemaToZodShape } from "./json-schema-to-zod.js";

/** Name for the throwaway in-process MCP server used to host a tool. */
const TOOL_SERVER_NAME = "llmwiki";

/**
 * Turn ceiling for a single-shot request. The SDK reports an error result when
 * this ceiling is *reached*, so it must sit above the one turn a clean
 * completion or forced tool call actually consumes — `1` errors on every call.
 */
const MAX_TURNS = 4;

/**
 * Appended to text-generation prompts. The Agent SDK runs an agentic model that
 * otherwise prefixes answers with conversational scaffolding ("I'll write…");
 * this keeps the output to the requested document, matching the raw API path.
 */
const OUTPUT_ONLY_DIRECTIVE =
  "Respond with only the requested content — no preamble, explanation, or sign-off.";

/** A content block on an assistant message (text or tool_use). */
interface AssistantBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** Join the user-role message contents into a single prompt string. */
function buildPrompt(messages: LLMMessage[]): string {
  return messages.map((message) => message.content).join("\n\n");
}

/** High-frequency SDK message types/subtypes that add noise without insight. */
const NOISY_MESSAGES = new Set(["thinking_tokens", "rate_limit_event"]);

/** Resolve the LLMWIKI_DEBUG level: off, a concise trace, or the full SDK firehose. */
function debugLevel(): "off" | "on" | "verbose" {
  const value = process.env.LLMWIKI_DEBUG?.trim().toLowerCase();
  if (!value) return "off";
  return value === "verbose" || value === "2" ? "verbose" : "on";
}

/**
 * Extra query options that surface what the Agent SDK is doing. Always streams
 * the `claude` subprocess stderr when debugging; the full SDK verbose logs are
 * added only at the `verbose` level. Empty object unless LLMWIKI_DEBUG is set.
 */
function debugOptions(): { debug?: boolean; stderr?: (data: string) => void } {
  const level = debugLevel();
  if (level === "off") return {};
  return { debug: level === "verbose", stderr: (data) => process.stderr.write(data) };
}

/** Print a one-line trace of a meaningful SDK message (type and subtype). */
function traceMessage(raw: unknown): void {
  if (debugLevel() === "off") return;
  const message = raw as { type?: string; subtype?: string };
  if (NOISY_MESSAGES.has(message.subtype ?? "") || NOISY_MESSAGES.has(message.type ?? "")) return;
  const subtype = message.subtype ? `:${message.subtype}` : "";
  process.stderr.write(`[claude-agent] ${message.type ?? "?"}${subtype}\n`);
}

/** Accumulate text from assistant content blocks, optionally emitting each chunk. */
function accumulateText(blocks: AssistantBlock[], onToken?: (text: string) => void): string {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      text += block.text;
      onToken?.(block.text);
    }
  }
  return text;
}

/**
 * Extract the text of a success result, or throw on any error result subtype
 * (auth failure, max turns, execution failure, …). Failing loudly here keeps a
 * bad SDK run from silently producing empty or partial wiki output.
 */
function resultText(message: { subtype?: string; result?: string; errors?: string[] }): string {
  if (message.subtype === "success") return message.result ?? "";
  const detail = message.errors?.join("; ") || message.subtype || "unknown error";
  throw new Error(`Claude Agent SDK returned an error result: ${detail}`);
}

/** Return the input of the first matching `tool_use` block, or undefined. */
function findToolInput(
  blocks: AssistantBlock[],
  toolName: string,
  qualifiedName: string,
): unknown {
  const match = blocks.find(
    (block) =>
      block.type === "tool_use" && (block.name === toolName || block.name === qualifiedName),
  );
  return match?.input;
}

/** Claude Agent SDK-backed LLM provider using the local Claude Code login. */
export class ClaudeAgentProvider implements LLMProvider {
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  /** Send a single non-streaming completion request. */
  async complete(system: string, messages: LLMMessage[], _maxTokens: number): Promise<string> {
    return this.runText(system, buildPrompt(messages));
  }

  /** Stream a completion, invoking onToken for each text chunk. */
  async stream(
    system: string,
    messages: LLMMessage[],
    _maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string> {
    return this.runText(system, buildPrompt(messages), onToken);
  }

  /** Run a single-shot, tool-free query and accumulate the assistant's text. */
  private async runText(
    system: string,
    prompt: string,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const response = query({
      prompt,
      options: {
        systemPrompt: `${system}\n\n${OUTPUT_ONLY_DIRECTIVE}`,
        model: this.model,
        maxTurns: MAX_TURNS,
        tools: [],
        allowedTools: [],
        ...debugOptions(),
      },
    });

    let streamed = "";
    let finalText = "";
    for await (const message of response) {
      traceMessage(message);
      if (message.type === "assistant") {
        streamed += accumulateText(message.message.content as AssistantBlock[], onToken);
      } else if (message.type === "result") {
        finalText = resultText(message);
      }
    }
    return finalText || streamed;
  }

  /**
   * Force a single structured tool call and return its input as a JSON string,
   * matching the shape callers parse from the other providers.
   */
  async toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    _maxTokens: number,
  ): Promise<string> {
    const requested = tools[0];
    const qualifiedName = `mcp__${TOOL_SERVER_NAME}__${requested.name}`;
    const sdkTool = tool(
      requested.name,
      requested.description,
      jsonSchemaToZodShape(requested.input_schema),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const mcpServer = createSdkMcpServer({ name: TOOL_SERVER_NAME, tools: [sdkTool] });

    const response = query({
      prompt: buildPrompt(messages),
      options: {
        systemPrompt: `${system}\n\nRespond by calling the \`${requested.name}\` tool.`,
        model: this.model,
        maxTurns: MAX_TURNS,
        mcpServers: { [TOOL_SERVER_NAME]: mcpServer },
        // Disable every built-in tool; only the in-process MCP tool is reachable.
        tools: [],
        allowedTools: [qualifiedName],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...debugOptions(),
      },
    });
    return collectToolInput(response, requested.name, qualifiedName);
  }

  /** Produce a single embedding vector via Voyage (Anthropic has no endpoint). */
  async embed(text: string): Promise<number[]> {
    return voyageEmbed(text);
  }

  /** Produce embedding vectors for multiple texts via a single Voyage API call. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return voyageEmbedBatch(texts);
  }
}

/** An SDK message: assistant content, or a result whose error subtype must throw. */
interface StreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  errors?: string[];
  message?: { content: AssistantBlock[] };
}

/**
 * Read the first matching `tool_use` input from a query stream as JSON. Throws
 * on an SDK error result, and throws if the model never called the tool (prose
 * or empty output) — callers expect JSON, so a silent fallback would degrade
 * into zero extracted concepts or broken eval output.
 */
async function collectToolInput(
  response: AsyncIterable<unknown>,
  toolName: string,
  qualifiedName: string,
): Promise<string> {
  let prose = "";
  for await (const raw of response) {
    traceMessage(raw);
    const message = raw as StreamMessage;
    if (message.type === "result") {
      resultText(message); // throws on any error result; success is ignored here
      continue;
    }
    if (message.type !== "assistant" || !message.message) continue;
    const input = findToolInput(message.message.content, toolName, qualifiedName);
    if (input !== undefined) return JSON.stringify(input);
    prose += accumulateText(message.message.content);
  }
  const suffix = prose ? `; it responded with prose instead: ${prose.slice(0, 200)}` : ".";
  throw new Error(`Claude Agent SDK did not call the "${toolName}" tool${suffix}`);
}
