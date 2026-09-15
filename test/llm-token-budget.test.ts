/**
 * Completion budget selection at the real provider HTTP boundary. The override
 * must reach text, structured and streaming requests without changing defaults.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callClaude } from "../src/utils/llm.js";

beforeEach(() => {
  vi.stubEnv("LLMWIKI_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("LLMWIKI_MODEL", "gpt-4o");
  vi.stubEnv("LLMWIKI_OPENAI_TOKEN_PARAM", undefined);
  vi.stubEnv("LLMWIKI_OPENAI_REASONING_EFFORT", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Respond in the protocol the real provider selected, without contacting a model. */
function responseFor(body: Record<string, unknown>): Response {
  if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
  return Response.json({ choices: [{ message: { content: "ok", tool_calls: body.tools ? [{
    type: "function", function: { name: "extract", arguments: '{"ok":true}' },
  }] : undefined } }] });
}

it.each(["complete", "stream", "tools"])("selects the token budget for %s", async (mode) => {
  for (const [setting, explicit, expected] of [[undefined, undefined, 4096], ["  ", undefined, 4096],
    ["8192", undefined, 8192], ["invalid", 128, 128]] as const) {
    vi.stubEnv("LLMWIKI_MAX_TOKENS", setting);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return responseFor(body);
    });
    const result = await callClaude({ system: "s", messages: [], maxTokens: explicit, stream: mode === "stream",
      tools: mode === "tools" ? [{ name: "extract", description: "Extract", input_schema: {} }] : undefined });
    expect(result).toBe(mode === "tools" ? '{"ok":true}' : "ok");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.max_tokens).toBe(expected);
  }
});

it.each(["0", "-1", "1.5", "invalid", "9007199254740992", "1e3"])("rejects %s without a request or backoff", async (setting) => {
  vi.stubEnv("LLMWIKI_MAX_TOKENS", setting);
  const network = vi.fn(async () => responseFor({}));
  vi.stubGlobal("fetch", network);
  const timer = vi.spyOn(globalThis, "setTimeout");
  await expect(callClaude({ system: "s", messages: [] })).rejects.toThrow("LLMWIKI_MAX_TOKENS");
  expect(network).not.toHaveBeenCalled();
  expect(timer).not.toHaveBeenCalled();
});
