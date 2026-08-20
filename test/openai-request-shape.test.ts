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

import { describe, it, expect, afterEach } from "vitest";
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

afterEach(restore);

/** Capture the body the provider hands the SDK, without any network call. */
function captureRequest(provider: OpenAIProvider): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  const client = Reflect.get(provider, "client") as {
    chat: { completions: { create: unknown } };
  };
  client.chat.completions.create = async (body: Record<string, unknown>) => {
    bodies.push(body);
    return { choices: [{ message: { content: "ok" } }] };
  };
  return bodies;
}

describe("tokenLimitParams", () => {
  it("keeps max_tokens for classic chat models", () => {
    expect(tokenLimitParams("gpt-4o", 100)).toEqual({ max_tokens: 100 });
  });

  it.each(["o1", "o3-mini", "o4-mini", "gpt-5.6", "GPT-5-turbo"])(
    "uses max_completion_tokens for %s",
    model => {
      expect(tokenLimitParams(model, 100)).toEqual({ max_completion_tokens: 100 });
    },
  );

  it("lets the env override force the new spelling for a gateway id", () => {
    setEnv({ [TOKEN_PARAM_ENV]: "max_completion_tokens" });
    expect(tokenLimitParams("vendor-private-model", 100)).toEqual({
      max_completion_tokens: 100,
    });
  });

  it("lets the env override force the old spelling for a matching prefix", () => {
    setEnv({ [TOKEN_PARAM_ENV]: "max_tokens" });
    expect(tokenLimitParams("gpt-5.6", 100)).toEqual({ max_tokens: 100 });
  });

  it("rejects an unknown override instead of sending it", () => {
    setEnv({ [TOKEN_PARAM_ENV]: "maxTokens" });
    expect(() => tokenLimitParams("gpt-4o", 100)).toThrow(OpenAIRequestConfigError);
  });
});

describe("reasoningParams", () => {
  it("sends nothing when unconfigured", () => {
    expect(reasoningParams()).toEqual({});
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"])(
    "passes %s through",
    effort => {
      setEnv({ [REASONING_EFFORT_ENV]: effort });
      expect(reasoningParams()).toEqual({ reasoning_effort: effort });
    },
  );

  it("normalizes whitespace and case", () => {
    setEnv({ [REASONING_EFFORT_ENV]: "  NONE  " });
    expect(reasoningParams()).toEqual({ reasoning_effort: "none" });
  });

  it("rejects an unknown effort instead of sending it", () => {
    setEnv({ [REASONING_EFFORT_ENV]: "maximum" });
    expect(() => reasoningParams()).toThrow(OpenAIRequestConfigError);
  });
});

describe("OpenAIProvider request bodies", () => {
  it("sends max_tokens for a classic model", async () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.complete("system", [], 512);
    expect(bodies[0]).toMatchObject({ max_tokens: 512 });
    expect(bodies[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("sends max_completion_tokens for a reasoning model", async () => {
    const provider = new OpenAIProvider("gpt-5.6", { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.complete("system", [], 512);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 512 });
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });

  it("applies the same shape on the tool-call path, keeping tool_choice", async () => {
    setEnv({ [REASONING_EFFORT_ENV]: "none" });
    const provider = new OpenAIProvider("gpt-5.6", { apiKey: "test" });
    const bodies = captureRequest(provider);
    await provider.toolCall("system", [], [], 512);
    expect(bodies[0]).toMatchObject({
      max_completion_tokens: 512,
      reasoning_effort: "none",
      tool_choice: "required",
    });
  });
});
