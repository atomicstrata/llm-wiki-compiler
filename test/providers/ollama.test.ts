/**
 * Tests for OllamaProvider native structured output and host resolution.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONCEPT_EXTRACTION_TOOL } from "../../src/compiler/prompts.js";
import { OllamaProvider, resolveOllamaNativeHost } from "../../src/providers/ollama.js";

const TOOL_MESSAGES = [{ role: "user" as const, content: "extract" }];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveOllamaNativeHost", () => {
  it("strips /v1 from OLLAMA_HOST-style URLs", () => {
    expect(resolveOllamaNativeHost("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(resolveOllamaNativeHost("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });

  it("preserves reverse-proxy path prefixes before /v1", () => {
    expect(resolveOllamaNativeHost("https://proxy.example.com/ollama/v1")).toBe(
      "https://proxy.example.com/ollama",
    );
  });

  it("preserves host and port from remote OLLAMA_HOST values", () => {
    expect(resolveOllamaNativeHost("http://ollama.internal:11434/v1")).toBe(
      "http://ollama.internal:11434",
    );
  });

  it("throws when the URL is invalid", () => {
    expect(() => resolveOllamaNativeHost("not-a-url")).toThrow(/Invalid OLLAMA_HOST URL/);
  });

  it("uses the default OLLAMA_HOST when unset", () => {
    expect(resolveOllamaNativeHost()).toBe("http://localhost:11434");
    expect(resolveOllamaNativeHost("   ")).toBe("http://localhost:11434");
  });
});

describe("OllamaProvider.toolCall", () => {
  it("calls native /api/chat with format schema instead of OpenAI tool_calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            concepts: [{ concept: "X", summary: "Y", is_new: true }],
          }),
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaProvider("llama3.1:latest", {
      baseURL: "http://localhost:11434/v1",
    });

    const output = await provider.toolCall(
      "system",
      TOOL_MESSAGES,
      [CONCEPT_EXTRACTION_TOOL],
      4096,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.format).toEqual(CONCEPT_EXTRACTION_TOOL.input_schema);
    expect(body.model).toBe("llama3.1:latest");
    expect(body.think).toBeUndefined();
    expect(JSON.parse(output).concepts).toHaveLength(1);
  });

  it("uses OLLAMA_EMBEDDINGS_HOST only for embeddings, not native tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            concepts: [{ concept: "A", summary: "B", is_new: false }],
          }),
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaProvider("llama3.1", {
      baseURL: "http://chat-host:11434/v1",
      embeddingsBaseURL: "http://embed-host:11435/v1",
    });

    await provider.toolCall("system", TOOL_MESSAGES, [CONCEPT_EXTRACTION_TOOL], 1024);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://chat-host:11434/api/chat",
      expect.any(Object),
    );
  });

  it("targets the proxied native base URL when OLLAMA_HOST has a path prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ concepts: [] }) },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaProvider("llama3.1", {
      baseURL: "https://proxy.example.com/ollama/v1",
    });

    await provider.toolCall("system", TOOL_MESSAGES, [CONCEPT_EXTRACTION_TOOL], 1024);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example.com/ollama/api/chat",
      expect.any(Object),
    );
  });

  it("throws when OLLAMA_HOST is not a valid URL", () => {
    expect(
      () => new OllamaProvider("llama3.1", { baseURL: "not-a-url" }),
    ).toThrow(/Invalid OLLAMA_HOST URL/);
  });

  it("throws when Ollama returns a non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "model not found",
      }),
    );

    const provider = new OllamaProvider("llama3.1", {
      baseURL: "http://localhost:11434/v1",
    });

    await expect(
      provider.toolCall("system", TOOL_MESSAGES, [CONCEPT_EXTRACTION_TOOL], 1024),
    ).rejects.toThrow(/Ollama \/api\/chat failed \(500\): model not found/);
  });

  it("throws when Ollama returns no message content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: {} }),
      }),
    );

    const provider = new OllamaProvider("llama3.1", {
      baseURL: "http://localhost:11434/v1",
    });

    await expect(
      provider.toolCall("system", TOOL_MESSAGES, [CONCEPT_EXTRACTION_TOOL], 1024),
    ).rejects.toThrow(/returned no message content/);
  });

  it("aborts the request when timeoutMs elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaProvider("llama3.1", {
      baseURL: "http://localhost:11434/v1",
      timeoutMs: 1000,
    });

    const promise = provider.toolCall(
      "system",
      TOOL_MESSAGES,
      [CONCEPT_EXTRACTION_TOOL],
      1024,
    );
    const rejection = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
  });
});
