/**
 * Tests for the Claude Agent SDK LLM provider.
 *
 * The Agent SDK's `query()` is mocked so the tests stay offline: they verify
 * that complete/stream accumulate assistant text, that toolCall captures a
 * `tool_use` input as JSON, that embed delegates to Voyage, and that the
 * factory resolves the provider without requiring an API key.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const query = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => query(...args),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "llmwiki" })),
  tool: vi.fn((name: string) => ({ name })),
}));

const { ClaudeAgentProvider } = await import("../src/providers/claude-agent.js");
const { getProvider } = await import("../src/utils/provider.js");
const { PROVIDER_MODELS } = await import("../src/utils/constants.js");

/** Wrap messages in an async generator, mimicking the SDK's query() return. */
async function* messageStream(messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) yield message;
}

function assistantText(text: string): unknown {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

afterEach(() => {
  query.mockReset();
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.LLMWIKI_MODEL;
  delete process.env.VOYAGE_API_KEY;
});

describe("ClaudeAgentProvider generation", () => {
  it("accumulates assistant text for complete()", async () => {
    query.mockReturnValue(messageStream([assistantText("Hello "), assistantText("world")]));
    const result = await new ClaudeAgentProvider("m").complete("sys", [{ role: "user", content: "hi" }], 100);
    expect(result).toBe("Hello world");
  });

  it("prefers the final result text over intermediate assistant turns", async () => {
    query.mockReturnValue(
      messageStream([
        assistantText("I'll write the page: "),
        { type: "result", subtype: "success", result: "# Clean Page" },
      ]),
    );
    const result = await new ClaudeAgentProvider("m").complete("sys", [{ role: "user", content: "hi" }], 100);
    expect(result).toBe("# Clean Page");
  });

  it("emits text chunks via onToken for stream()", async () => {
    query.mockReturnValue(messageStream([assistantText("a"), assistantText("b")]));
    const chunks: string[] = [];
    const result = await new ClaudeAgentProvider("m").stream(
      "sys",
      [{ role: "user", content: "hi" }],
      100,
      (t) => chunks.push(t),
    );
    expect(chunks).toEqual(["a", "b"]);
    expect(result).toBe("ab");
  });

  it("captures tool_use input as JSON for toolCall()", async () => {
    const input = { concepts: [{ concept: "X" }] };
    query.mockReturnValue(
      messageStream([
        { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__llmwiki__extract_concepts", input }] } },
      ]),
    );
    const tools = [{ name: "extract_concepts", description: "d", input_schema: { type: "object", properties: {} } }];
    const result = await new ClaudeAgentProvider("m").toolCall("sys", [{ role: "user", content: "hi" }], tools, 100);
    expect(JSON.parse(result)).toEqual(input);
  });
});

describe("ClaudeAgentProvider failure handling", () => {
  const TOOLS = [
    { name: "extract_concepts", description: "d", input_schema: { type: "object", properties: {} } },
  ];

  it("throws on an SDK error result instead of returning partial text", async () => {
    query.mockReturnValue(
      messageStream([{ type: "result", subtype: "error_during_execution", errors: ["auth failed"] }]),
    );
    await expect(
      new ClaudeAgentProvider("m").complete("sys", [{ role: "user", content: "hi" }], 100),
    ).rejects.toThrow("error result: auth failed");
  });

  it("throws when the model never calls the tool", async () => {
    query.mockReturnValue(messageStream([{ type: "result", subtype: "success", result: "done" }]));
    await expect(
      new ClaudeAgentProvider("m").toolCall("sys", [{ role: "user", content: "hi" }], TOOLS, 100),
    ).rejects.toThrow('did not call the "extract_concepts" tool');
  });

  it("throws and surfaces prose when the model answers in text instead", async () => {
    query.mockReturnValue(messageStream([assistantText("I think the answer is 42.")]));
    await expect(
      new ClaudeAgentProvider("m").toolCall("sys", [{ role: "user", content: "hi" }], TOOLS, 100),
    ).rejects.toThrow("prose instead");
  });
});

describe("ClaudeAgentProvider embeddings", () => {
  it("delegates embed() to Voyage and throws without VOYAGE_API_KEY", async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(new ClaudeAgentProvider("m").embed("hi")).rejects.toThrow("VOYAGE_API_KEY");
  });
});

describe("getProvider with claude-agent", () => {
  it("resolves ClaudeAgentProvider with no API key required", () => {
    process.env.LLMWIKI_PROVIDER = "claude-agent";
    const provider = getProvider();
    expect(provider).toBeInstanceOf(ClaudeAgentProvider);
    expect(Reflect.get(provider, "model")).toBe(PROVIDER_MODELS["claude-agent"]);
  });

  it("respects LLMWIKI_MODEL override", () => {
    process.env.LLMWIKI_PROVIDER = "claude-agent";
    process.env.LLMWIKI_MODEL = "claude-opus-4-1";
    expect(Reflect.get(getProvider(), "model")).toBe("claude-opus-4-1");
  });
});
