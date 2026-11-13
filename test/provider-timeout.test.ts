/**
 * Tests for OpenAI/Ollama provider request timeout configuration.
 *
 * Issue #11: the OpenAI SDK defaults to a 10-minute request timeout, which
 * cuts off long Ollama compile-time completions on slower local hardware.
 * The provider now reads OLLAMA_TIMEOUT_MS / LLMWIKI_REQUEST_TIMEOUT_MS env
 * vars and sets a 30-minute Ollama default.
 */

import { describe, it, expect, afterEach, vi } from "bun:test";
import { OpenAIProvider, readTimeoutEnv } from "../src/providers/openai.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import {
  OPENAI_DEFAULT_TIMEOUT_MS,
  OLLAMA_DEFAULT_TIMEOUT_MS,
} from "../src/utils/constants.js";

afterEach(() => {
  delete process.env.OLLAMA_TIMEOUT_MS;
  delete process.env.LLMWIKI_REQUEST_TIMEOUT_MS;
  vi.restoreAllMocks();
});

/** Read the timeout the provider configured on the underlying OpenAI client. */
function getClientTimeout(provider: OpenAIProvider): number | undefined {
  // The OpenAI SDK stores the timeout as `timeout` on the client instance;
  // we cast to `unknown` first because the field is not part of its public
  // type, then narrow.
  const client = (provider as unknown as { client: { timeout?: number } }).client;
  return client.timeout;
}

describe("readTimeoutEnv", () => {
  it("returns the parsed integer when the env var is set", () => {
    process.env.OLLAMA_TIMEOUT_MS = "1500";
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBe(1500);
  });

  it("returns undefined when the env var is unset", () => {
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBeUndefined();
  });

  it("returns undefined when the env var is empty or whitespace", () => {
    process.env.OLLAMA_TIMEOUT_MS = "   ";
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBeUndefined();
  });

  it("returns undefined when the env var is non-numeric", () => {
    process.env.OLLAMA_TIMEOUT_MS = "thirty-minutes";
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBeUndefined();
  });

  it("rejects zero and negative values", () => {
    process.env.OLLAMA_TIMEOUT_MS = "0";
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBeUndefined();
    process.env.OLLAMA_TIMEOUT_MS = "-100";
    expect(readTimeoutEnv("OLLAMA_TIMEOUT_MS")).toBeUndefined();
  });
});

describe("OpenAIProvider timeout", () => {
  it("falls back to the OPENAI_DEFAULT_TIMEOUT_MS when nothing is set", () => {
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test" });
    expect(getClientTimeout(provider)).toBe(OPENAI_DEFAULT_TIMEOUT_MS);
  });

  it("uses LLMWIKI_REQUEST_TIMEOUT_MS when set", () => {
    process.env.LLMWIKI_REQUEST_TIMEOUT_MS = "60000";
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test" });
    expect(getClientTimeout(provider)).toBe(60000);
  });

  it("explicit timeoutMs option wins over env var", () => {
    process.env.LLMWIKI_REQUEST_TIMEOUT_MS = "60000";
    const provider = new OpenAIProvider("gpt-4o", { apiKey: "test", timeoutMs: 1234 });
    expect(getClientTimeout(provider)).toBe(1234);
  });
});

describe("OllamaProvider timeout", () => {
  it("uses the higher OLLAMA_DEFAULT_TIMEOUT_MS by default", () => {
    const provider = new OllamaProvider("llama3.1", { baseURL: "http://localhost:11434/v1" });
    expect(getClientTimeout(provider)).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
  });

  it("OLLAMA_TIMEOUT_MS overrides the default", () => {
    process.env.OLLAMA_TIMEOUT_MS = "120000";
    const provider = new OllamaProvider("llama3.1", { baseURL: "http://localhost:11434/v1" });
    expect(getClientTimeout(provider)).toBe(120000);
  });

  it("LLMWIKI_REQUEST_TIMEOUT_MS is honored when OLLAMA_TIMEOUT_MS is unset", () => {
    process.env.LLMWIKI_REQUEST_TIMEOUT_MS = "90000";
    const provider = new OllamaProvider("llama3.1", { baseURL: "http://localhost:11434/v1" });
    expect(getClientTimeout(provider)).toBe(90000);
  });

  it("OLLAMA_TIMEOUT_MS wins over LLMWIKI_REQUEST_TIMEOUT_MS when both set", () => {
    process.env.OLLAMA_TIMEOUT_MS = "120000";
    process.env.LLMWIKI_REQUEST_TIMEOUT_MS = "90000";
    const provider = new OllamaProvider("llama3.1", { baseURL: "http://localhost:11434/v1" });
    expect(getClientTimeout(provider)).toBe(120000);
  });

  it("explicit timeoutMs option wins over both env vars", () => {
    process.env.OLLAMA_TIMEOUT_MS = "120000";
    process.env.LLMWIKI_REQUEST_TIMEOUT_MS = "90000";
    const provider = new OllamaProvider("llama3.1", {
      baseURL: "http://localhost:11434/v1",
      timeoutMs: 5000,
    });
    expect(getClientTimeout(provider)).toBe(5000);
  });
});
