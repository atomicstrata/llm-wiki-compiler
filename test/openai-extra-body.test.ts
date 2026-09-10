/** Gateway body extensions must reach chat requests without replacing compile's contract. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAIRequestConfigError } from "../src/providers/openai-request.js";

beforeEach(() => {
  vi.stubEnv("LLMWIKI_OPENAI_TOKEN_PARAM", undefined);
  vi.stubEnv("LLMWIKI_OPENAI_REASONING_EFFORT", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Capture the real SDK body at transport, installing the stub before SDK construction. */
function captureRequests(response: () => Response): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return response();
  });
  return bodies;
}

it.each(["complete", "stream"] as const)("forwards extensions through %s and preserves an unset default", async (mode) => {
  for (const setting of [undefined, "  ", '{"thinking":{"type":"disabled"}}']) {
    vi.stubEnv("LLMWIKI_OPENAI_EXTRA_BODY", setting);
    const bodies = captureRequests(() => mode === "stream"
        ? new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
        : Response.json({ choices: [{ message: { content: "hello" } }] }));
    const provider = new OpenAIProvider("vendor/model", { apiKey: "test", baseURL: "http://127.0.0.1:9/v1" });
    expect(await provider[mode]("s", [], 128)).toBe("hello");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.thinking).toEqual(setting?.trim() ? { type: "disabled" } : undefined);
    expect(bodies[0]!.stream).toBe(mode === "stream" ? true : undefined);
  }
});

it("does not apply or validate chat extensions on the embedding path", async () => {
  vi.stubEnv("LLMWIKI_OPENAI_EXTRA_BODY", "not-chat-json");
  const bodies = captureRequests(() => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }));
  const provider = new OpenAIProvider("vendor/model", { apiKey: "test", embeddingModel: "embed-model" });
  expect(await provider.embed("source")).toEqual([1, 2]);
  expect(bodies).toEqual([{ model: "embed-model", input: "source", encoding_format: "float" }]);
});

it("adds vendor fields while preserving required structured extraction", async () => {
  vi.stubEnv("LLMWIKI_OPENAI_EXTRA_BODY", '{"thinking":{"type":"disabled"},"temperature":0.2}');
  const bodies = captureRequests(() => Response.json({ choices: [{ message: { tool_calls: [{
      type: "function", function: { name: "extract", arguments: '{"concepts":[]}' },
    }] } }] }));
  const provider = new OpenAIProvider("vendor/model", { apiKey: "test" });
  const result = await provider.toolCall("Extract", [], [{ name: "extract", description: "Extract", input_schema: {} }], 128);
  expect(result).toBe('{"concepts":[]}');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.2,
    model: "vendor/model", max_tokens: 128, tool_choice: "required",
    messages: [{ role: "system", content: "Extract" }] });
});

it.each(["broken", "null", "[]", "true", "1", '"text"',
  ...["model", "messages", "tools", "tool_choice", "stream", "max_tokens", "max_completion_tokens", "reasoning_effort"]
    .map((field) => JSON.stringify({ [field]: null })),
])("rejects unsupported extra body %s before sending", async (value) => {
  vi.stubEnv("LLMWIKI_OPENAI_EXTRA_BODY", value);
  const network = vi.fn(async () => Response.json({ choices: [] }));
  vi.stubGlobal("fetch", network);
  const provider = new OpenAIProvider("vendor/model", { apiKey: "test" });
  await expect(provider.complete("s", [], 128)).rejects.toBeInstanceOf(OpenAIRequestConfigError);
  expect(network).not.toHaveBeenCalled();
});
