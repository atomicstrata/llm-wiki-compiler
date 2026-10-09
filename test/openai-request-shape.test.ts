/**
 * @file test/openai-request-shape.test.ts
 * @description Which token-limit field and reasoning parameters reach the Chat
 * Completions API.
 *
 * Reasoning models reject `max_tokens` and require `max_completion_tokens`, and
 * some reject a tool-carrying request that omits `reasoning_effort`. Detection
 * is by model-id prefix, with env overrides for OpenAI-compatible gateways that
 * re-badge those models under ids no prefix list can anticipate.
 *
 * The provider cases matter as much as the unit ones: the three completion
 * methods each built their own body before, so the regression this guards is
 * one of them drifting back to a hard-coded `max_tokens`.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  OpenAIRequestConfigError,
  reasoningParams,
  tokenLimitParams,
} from "../src/providers/openai-request.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const TOKEN_PARAM_ENV = "LLMWIKI_OPENAI_TOKEN_PARAM";
const REASONING_EFFORT_ENV = "LLMWIKI_OPENAI_REASONING_EFFORT";

const { setEnv, restore } = createEnvSnapshot([TOKEN_PARAM_ENV, REASONING_EFFORT_ENV]);

beforeEach(() => setEnv({}));
afterEach(restore);

/** Capture the body the provider hands the SDK, without any network call. */
function captureRequest(provider: OpenAIProvider): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  const client = Reflect.get(provider, "client") as {
    chat: { completions: { create: unknown } };
  };
  client.chat.completions.create = async (body: Record<string, unknown>) => {
    bodies.push(body);
    if (body.stream) return streamChunks();
    return { choices: [{ message: { content: "ok" } }] };
  };
  return bodies;
}

/** Representative text chunks returned by the SDK streaming interface. */
async function* streamChunks() {
  yield { choices: [{ delta: { content: "hello" } }] };
  yield { choices: [{ delta: {} }] };
  yield { choices: [{ delta: { content: " world" } }] };
}

describe("tokenLimitParams", () => {
  it("keeps max_tokens for classic chat models", () => {
    expect(tokenLimitParams("gpt-4o", 100)).toEqual({ max_tokens: 100 });
  });

  it.each(["o1", "o3-mini", "o4-mini", "gpt-5.6", "GPT-5-turbo", "gpt-6-luna", "GPT-6-LUNA-2026"])(
    "uses max_completion_tokens for %s",
    model => {
      expect(tokenLimitParams(model, 100)).toEqual({ max_completion_tokens: 100 });
    },
  );

  it.each(["gpt-6", "gpt-6-sol", "gpt-6-lunatic", "vendor/gpt-6-luna"])(
    "does not infer the Luna request contract for %s", model => {
      expect(tokenLimitParams(model, 100)).toEqual({ max_tokens: 100 });
      expect(reasoningParams(model)).toEqual({});
    },
  );

  it("lets the env override force the new spelling for a gateway id", () => {
    setEnv({ [TOKEN_PARAM_ENV]: "max_completion_tokens" });
    expect(tokenLimitParams("vendor-private-model", 100)).toEqual({
      max_completion_tokens: 100,
    });
  });

  it.each(["gpt-5.6", "gpt-6-luna"])("lets the token override win for %s", model => {
    setEnv({ [TOKEN_PARAM_ENV]: "max_tokens" });
    expect(tokenLimitParams(model, 100)).toEqual({ max_tokens: 100 });
  });

  it("rejects an unknown override instead of sending it", () => {
    setEnv({ [TOKEN_PARAM_ENV]: "maxTokens" });
    expect(() => tokenLimitParams("gpt-4o", 100)).toThrow(OpenAIRequestConfigError);
  });
});

describe("reasoningParams", () => {
  it("sends nothing for a model with no opinion on reasoning", () => {
    expect(reasoningParams("gpt-4o-mini")).toEqual({});
  });

  it.each(["gpt-5.6", "gpt-5.6-luna", "GPT-5.6-sol", "gpt-6-luna", "GPT-6-LUNA-2026"])(
    "defaults %s to none, because it rejects tools without an effort",
    model => {
      expect(reasoningParams(model)).toEqual({ reasoning_effort: "none" });
    },
  );

  it.each(["gpt-5", "gpt-5-mini", "gpt-5-pro", "gpt-5.1", "gpt-5.60", "gpt-5.6custom"])(
    "does not impose GPT-5.6 effort semantics on %s",
    model => { expect(reasoningParams(model)).toEqual({}); },
  );

  it("leaves the o-series alone rather than guessing a value it may reject", () => {
    expect(reasoningParams("o3-mini")).toEqual({});
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"])(
    "passes %s through",
    effort => {
      setEnv({ [REASONING_EFFORT_ENV]: effort });
      expect(reasoningParams("gpt-4o-mini")).toEqual({ reasoning_effort: effort });
    },
  );

  it.each(["gpt-5.6-luna", "gpt-6-luna"])("lets the effort override win for %s", model => {
    setEnv({ [REASONING_EFFORT_ENV]: "high" });
    expect(reasoningParams(model)).toEqual({ reasoning_effort: "high" });
  });

  it("normalizes whitespace and case", () => {
    setEnv({ [REASONING_EFFORT_ENV]: "  NONE  " });
    expect(reasoningParams("gpt-4o-mini")).toEqual({ reasoning_effort: "none" });
  });

  it("rejects an unknown effort instead of sending it", () => {
    setEnv({ [REASONING_EFFORT_ENV]: "maximum" });
    expect(() => reasoningParams("gpt-4o-mini")).toThrow(OpenAIRequestConfigError);
  });
});

describe("OpenAIProvider request bodies", () => {
  it.each(["gpt-4o", "gpt-5.6", "gpt-6-luna"])("preserves request adaptation and chunks while streaming %s", async (model) => {
    const provider = new OpenAIProvider(model, { apiKey: "test" });
    const bodies = captureRequest(provider);
    const tokens: string[] = [];
    expect(await provider.stream("system", [], 512, token => tokens.push(token))).toBe("hello world");
    expect(tokens).toEqual(["hello", " world"]);
    expect(bodies[0]).toMatchObject(model === "gpt-4o"
      ? { stream: true, max_tokens: 512 }
      : { stream: true, max_completion_tokens: 512, reasoning_effort: "none" });
    expect(bodies[0]).not.toHaveProperty(model === "gpt-4o" ? "max_completion_tokens" : "max_tokens");
  });

  it("sends max_tokens for a classic model", async () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.complete("system", [], 512);
    expect(bodies[0]).toMatchObject({ max_tokens: 512 });
    expect(bodies[0]).not.toHaveProperty("max_completion_tokens");
  });

  it.each(["gpt-5.6", "gpt-6-luna"])("adapts text generation for %s", async model => {
    const provider = new OpenAIProvider(model, { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.complete("system", [], 512);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 512, reasoning_effort: "none" });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it.each(["gpt-5.6", "gpt-6-luna"])("adapts required tool calls for %s", async model => {
    const provider = new OpenAIProvider(model, { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.toolCall("system", [], [], 512);
    expect(bodies[0]).toMatchObject({
      max_completion_tokens: 512,
      reasoning_effort: "none",
      tool_choice: "required",
    });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });
});
