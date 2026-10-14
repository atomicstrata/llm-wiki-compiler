/**
 * Converse provider requests against a real HTTP boundary.
 * Credentials, route paths, and payloads are verified without replacing the
 * provider or its transport. No remote service or AWS identity is required.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProvider, resolveActiveModelId } from "../src/utils/provider.js";
import { ensureCompileProviderAvailable } from "../src/utils/provider-guard.js";
import { resolveConverseSettings } from "../src/providers/converse.js";
import { callClaude } from "../src/utils/llm.js";
import { converseEvent } from "./fixtures/converse-http.js";
import { listenLoopback, closeLoopback } from "./fixtures/loopback-http.js";

describe("Converse generation route", () => {
  let server: Server;
  let requests: { path: string; authorization: string; body: unknown }[];
  let responseBody: unknown;
  let streamFrames: Buffer[];
  let statusCode: number;
  let delayMs: number;

  beforeEach(async () => {
    requests = [];
    streamFrames = [];
    statusCode = 200;
    delayMs = 0;
    responseBody = { output: { message: { role: "assistant", content: [
      { text: "Supported " }, { text: "facts." },
    ] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } };
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (request.url?.endsWith("/converse-stream")) {
        response.setHeader("Content-Type", "application/vnd.amazon.eventstream");
        for (const frame of streamFrames) response.write(frame);
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.statusCode = statusCode;
      response.end(JSON.stringify(responseBody));
    });
    const baseURL = await listenLoopback(server);
    vi.stubEnv("LLMWIKI_PROVIDER", "converse");
    vi.stubEnv("LLMWIKI_MODEL", "eu.example.model-v1:0");
    vi.stubEnv("LLMWIKI_CONVERSE_BASE_URL", `${baseURL}/proxy/route`);
    vi.stubEnv("LLMWIKI_CONVERSE_API_KEY", "route-secret");
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeLoopback(server);
  });

  it("completes through the explicit route using bearer authentication", async () => {
    ensureCompileProviderAvailable(false);
    const result = await getProvider().complete("Use only sources", [{ role: "user", content: "Source facts" }], 128);
    expect(result).toBe("Supported facts.");
    expect(requests).toEqual([{ path: "/proxy/route/model/eu.example.model-v1%3A0/converse",
      authorization: "Bearer route-secret", body: {
        system: [{ text: "Use only sources" }], messages: [{ role: "user", content: [{ text: "Source facts" }] }],
        inferenceConfig: { maxTokens: 128 },
      } }]);
  });

  it.each(["any", "auto"])("extracts structured tool input with %s selection", async (choice) => {
    vi.stubEnv("LLMWIKI_CONVERSE_TOOL_CHOICE", choice);
    responseBody = { output: { message: { role: "assistant", content: [{ toolUse: {
      toolUseId: "extract-1", name: "extract_concepts", input: { concepts: [] },
    } }] } }, stopReason: "tool_use" };
    const schema = { type: "object", properties: { concepts: { type: "array" } }, required: ["concepts"] };
    const result = await getProvider().toolCall("Extract", [{ role: "user", content: "Facts" }], [
      { name: "extract_concepts", description: "Extract supported concepts", input_schema: schema },
    ], 128);
    expect(JSON.parse(result)).toEqual({ concepts: [] });
    expect(requests[0].body).toMatchObject({ toolConfig: {
      tools: [{ toolSpec: { name: "extract_concepts", description: "Extract supported concepts", inputSchema: { json: schema } } }],
      toolChoice: { [choice]: {} },
    } });
  });

  it("streams page text from binary Converse events", async () => {
    streamFrames = [
      converseEvent("messageStart", { role: "assistant" }),
      converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Supported " } }),
      converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "facts." } }),
      converseEvent("messageStop", { stopReason: "end_turn" }),
      converseEvent("metadata", { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }),
    ];
    const tokens: string[] = [];
    const result = await getProvider().stream("Write", [{ role: "user", content: "Facts" }], 128, (token) => tokens.push(token));
    expect(result).toBe("Supported facts.");
    expect(tokens).toEqual(["Supported ", "facts."]);
    expect(requests[0].path).toBe("/proxy/route/model/eu.example.model-v1%3A0/converse-stream");
  });

  it.each([undefined, "max_tokens", "guardrail_intervened"])("rejects incomplete streamed output (%s)", async (stopReason) => {
    streamFrames = [converseEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Partial page" } })];
    if (stopReason) streamFrames.push(converseEvent("messageStop", { stopReason }));
    await expect(getProvider().stream("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toThrow("Converse generation did not finish");
  });

  it.each([400, 401, 403, 404, 429, 503])("reports HTTP %s without echoing remote content", async (status) => {
    statusCode = status;
    responseBody = { message: "secret-sentinel and uploaded-source-sentinel", __type: "ValidationException" };
    await expect(getProvider().complete("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toMatchObject({
      message: `Converse request failed (HTTP ${status})`,
      nonRetryable: status >= 400 && status < 500 && status !== 429,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %s in the compiler wrapper", async (status) => {
    statusCode = status;
    responseBody = { message: "secret-sentinel", __type: "ValidationException" };
    await expect(callClaude({ system: "Write", messages: [], maxTokens: 128 }))
      .rejects.toThrow(`Converse request failed (HTTP ${status})`);
    expect(requests).toHaveLength(1);
  });

  it.each([429, 503])("retries transient HTTP %s in the compiler wrapper", async (status) => {
    statusCode = status;
    responseBody = { __type: "ThrottlingException" };
    const pending = callClaude({ system: "Write", messages: [], maxTokens: 128 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    statusCode = 200;
    responseBody = { output: { message: { content: [{ text: "Recovered" }] } }, stopReason: "end_turn" };
    await expect(pending).resolves.toBe("Recovered");
    expect(requests).toHaveLength(2);
  });

  it.each(["max_tokens", "content_filtered", undefined])("rejects incomplete non-streaming output (%s)", async (stopReason) => {
    responseBody = { stopReason, output: { message: { role: "assistant", content: [{ text: "Partial" }] } } };
    await expect(getProvider().complete("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toThrow("Converse generation did not finish");
  });

  it("does not accept a truncated tool call", async () => {
    responseBody = { stopReason: "max_tokens", output: { message: { role: "assistant", content: [{ toolUse: {
      toolUseId: "1", name: "extract", input: { concepts: [] },
    } }] } } };
    await expect(getProvider().toolCall("Extract", [], [{ name: "extract", description: "Extract", input_schema: { type: "object" } }], 128))
      .rejects.toThrow("Converse generation did not finish");
  });

  it("requires an explicit embedding provider before compilation when embeddings are enabled", () => {
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", undefined);
    expect(() => ensureCompileProviderAvailable()).toThrow("LLMWIKI_EMBEDDING_PROVIDER");
    expect(requests).toHaveLength(0);
  });

  it("resolves provenance model identity without requiring inference credentials", () => {
    vi.stubEnv("LLMWIKI_CONVERSE_API_KEY", undefined);
    expect(resolveActiveModelId()).toBe("eu.example.model-v1:0");
  });

  it.each(["not-a-url", "ftp://example.test", "https://user:secret@example.test", "https://example.test?key=secret"])("rejects invalid endpoint configuration before compilation: %s", (endpoint) => {
    vi.stubEnv("LLMWIKI_CONVERSE_BASE_URL", endpoint);
    expect(() => ensureCompileProviderAvailable(false)).toThrow("LLMWIKI_CONVERSE_BASE_URL");
    expect(requests).toHaveLength(0);
  });

  it("honors the configured model request deadline", async () => {
    vi.stubEnv("LLMWIKI_REQUEST_TIMEOUT_MS", "20");
    delayMs = 150;
    await expect(getProvider().complete("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toThrow("Converse request timed out");
  });

  it.each(["1.5", "0", "-1", "invalid", "Infinity", "NaN", "2147483648", "4294967296", "9007199254740992"])("rejects invalid request timeout before compilation: %s", (timeout) => {
    vi.stubEnv("LLMWIKI_REQUEST_TIMEOUT_MS", timeout);
    expect(() => ensureCompileProviderAvailable(false)).toThrow("LLMWIKI_REQUEST_TIMEOUT_MS");
    expect(requests).toHaveLength(0);
  });

  it.each([undefined, "", "   "])("defaults the request deadline only when unset or blank: %s", (timeout) => {
    vi.stubEnv("LLMWIKI_REQUEST_TIMEOUT_MS", timeout);
    expect(resolveConverseSettings().requestTimeoutMs).toBe(600_000);
  });

  it.each(["1", " 1500 ", "2147483647"])("accepts a supported integer request timeout: %s", (timeout) => {
    vi.stubEnv("LLMWIKI_REQUEST_TIMEOUT_MS", timeout);
    expect(resolveConverseSettings().requestTimeoutMs).toBe(Number(timeout));
  });

  it("does not expose model content in streamed error events", async () => {
    streamFrames = [converseEvent("validationException", { message: "uploaded-source-sentinel" })];
    await expect(getProvider().stream("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toThrow("Converse request failed");
  });

  it("rejects an empty successful response", async () => {
    responseBody = { output: { message: { role: "assistant", content: [] } }, stopReason: "end_turn" };
    await expect(getProvider().complete("Write", [{ role: "user", content: "Facts" }], 128)).rejects.toThrow("no text");
  });
});
