/**
 * Invalid local request settings must fail without network or retry backoff.
 * Exercises the real provider through the shared LLM entry point in all modes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callClaude } from "../src/utils/llm.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAIRequestConfigError } from "../src/providers/openai-request.js";

describe("OpenAI request configuration failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("LLMWIKI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("LLMWIKI_MODEL", "gpt-5.6");
    vi.stubEnv("LLMWIKI_OPENAI_TOKEN_PARAM", undefined);
    vi.stubEnv("LLMWIKI_OPENAI_REASONING_EFFORT", undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    ["LLMWIKI_OPENAI_TOKEN_PARAM", "complete"],
    ["LLMWIKI_OPENAI_TOKEN_PARAM", "stream"],
    ["LLMWIKI_OPENAI_TOKEN_PARAM", "toolCall"],
    ["LLMWIKI_OPENAI_REASONING_EFFORT", "complete"],
    ["LLMWIKI_OPENAI_REASONING_EFFORT", "stream"],
    ["LLMWIKI_OPENAI_REASONING_EFFORT", "toolCall"],
  ] as const)("rejects invalid %s once in %s", async (variable, method) => {
    vi.stubEnv(variable, "invalid-value");
    const attempt = vi.spyOn(OpenAIProvider.prototype, method);
    const network = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", network);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const result = callClaude({
      system: "Extract", messages: [], stream: method === "stream",
      tools: method === "toolCall" ? [{ name: "extract", description: "Extract", input_schema: {} }] : undefined,
    }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(OpenAIRequestConfigError);
    expect((error as Error).message).toContain(variable);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(timer).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
