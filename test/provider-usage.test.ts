/**
 * Usage receipts observed through public providers against a simulated HTTP API.
 * Returned content, receipts and failures are the contract; SDK internals are real.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { ConverseProvider } from "../src/providers/converse.js";
import { voyageEmbed } from "../src/providers/voyage-embed.js";
import { converseEvent } from "./fixtures/converse-http.js";
import { callClaude } from "../src/utils/llm.js";
import { listenLoopback, closeLoopback } from "./fixtures/loopback-http.js";

let server: Server;
let directory: string;
let baseURL: string;
let payload: object;
let wireBody: string | Buffer | undefined;
let contentType: string;
let requestCount: number;

beforeEach(async () => {
  wireBody = undefined;
  requestCount = 0;
  contentType = "application/json";
  directory = await mkdtemp(path.join(tmpdir(), "usage-receipts-"));
  vi.stubEnv("LLMWIKI_USAGE_DIRECTORY", directory);
  vi.stubEnv("LLMWIKI_USAGE_EXECUTION_ID", "execution-1");
  server = createServer(async (request, response) => {
    requestCount += 1;
    for await (const _chunk of request) { /* Drain the request. */ }
    response.setHeader("content-type", contentType);
    response.setHeader("x-request-id", "request-1");
    response.setHeader("request-id", "request-1");
    response.end(wireBody ?? JSON.stringify(payload));
  });
  baseURL = await listenLoopback(server);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeLoopback(server);
  await rm(directory, { recursive: true, force: true });
});

it("records actual OpenAI model and inclusive cache usage for each call", async () => {
  payload = { id: "response", model: "actual-model", choices: [{ message: { content: "private text" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } };
  const provider = new OpenAIProvider("requested-model", { baseURL, apiKey: "secret" });
  expect(await provider.complete("private prompt", [], 100)).toBe("private text");
  await provider.complete("private prompt", [], 100);
  const events = await receipts();
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ provider: "openai", model: "actual-model", operation: "complete", responseId: "response", requestId: "request-1",
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null, usageComplete: true });
  expect(events[0].eventId).not.toBe(events[1].eventId);
  expect(JSON.stringify(events)).not.toMatch(/private|secret/);
});

it.each([undefined, null, {}, { cached_tokens: 0 }])("preserves missing versus zero OpenAI cache usage (%j)", async (details) => {
  payload = { model: "model", choices: [{ message: { content: "text" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: details } };
  await new OpenAIProvider("model", { baseURL, apiKey: "secret" }).complete("prompt", [], 100);
  const events = await receipts();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ inputTokens: 100, outputTokens: 20,
    cacheReadTokens: details?.cached_tokens === 0 ? 0 : null, cacheWriteTokens: null });
});

it.each([undefined, null, 0, 30])("retains OpenAI cache writes across completion paths (%s)", async (writes) => {
  const usage = { prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: writes } };
  payload = { model: "gpt-6-luna", choices: [{ message: { content: "text" } }], usage };
  const provider = new OpenAIProvider("gpt-6-luna", { baseURL, apiKey: "secret" });
  await provider.complete("prompt", [], 100);
  await provider.toolCall("prompt", [], [], 100);
  contentType = "text/event-stream";
  wireBody = `data: ${JSON.stringify({ model: "gpt-6-luna", choices: [], usage })}\n\n` + 'data: [DONE]\n\n';
  await provider.stream("prompt", [], 100);
  const events = await receipts();
  expect(events).toHaveLength(3);
  expect(events.map(event => event.operation).sort()).toEqual(["complete", "stream", "toolCall"]);
  for (const event of events) expect(event).toMatchObject({ inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 60, cacheWriteTokens: writes ?? null, usageComplete: true });
});

it("records embedding usage even when returned vectors are invalid", async () => {
  payload = { model: "actual-embedding", data: [], usage: { prompt_tokens: 12, total_tokens: 12 } };
  const provider = new OpenAIProvider("chat", { baseURL, apiKey: "secret", embeddingModel: "requested-embedding" });
  await expect(provider.embed("private source")).rejects.toThrow();
  expect(await receipts()).toMatchObject([{ provider: "openai", model: "actual-embedding", operation: "embed",
    inputTokens: 12, outputTokens: 0, usageComplete: true }]);
});

it.each([undefined, {}, { prompt_tokens: 0 }])("distinguishes missing embedding usage from observed zero (%j)", async (usage) => {
  payload = { model: "embedding", data: [{ index: 0, embedding: [0.1, 0.2] }], usage };
  const provider = new OpenAIProvider("chat", { baseURL, apiKey: "secret", embeddingModel: "embedding" });
  expect(await provider.embed("source")).toEqual([0.1, 0.2]);
  const known = usage?.prompt_tokens === 0;
  expect(await receipts()).toMatchObject([{ inputTokens: known ? 0 : null,
    outputTokens: known ? 0 : null, usageComplete: known }]);
});

it("normalizes Anthropic cached input without losing consumed tokens", async () => {
  payload = { id: "message", type: "message", role: "assistant", model: "actual-claude",
    content: [{ type: "text", text: "result" }], stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 } };
  const provider = new AnthropicProvider("requested", { baseURL, apiKey: "secret" });
  expect(await provider.complete("prompt", [], 100)).toBe("result");
  expect(await receipts()).toMatchObject([{ model: "actual-claude", inputTokens: 110, outputTokens: 10,
    cacheReadTokens: 60, cacheWriteTokens: 30 }]);
});

it("keeps absent usage distinct from zero", async () => {
  payload = { model: "model", choices: [{ message: { content: "text" } }] };
  await new OpenAIProvider("model", { baseURL, apiKey: "secret" }).complete("prompt", [], 100);
  expect(await receipts()).toMatchObject([{ inputTokens: null, outputTokens: null, usageComplete: false }]);
});

it("records the final OpenAI stream usage once", async () => {
  contentType = "text/event-stream";
  wireBody = 'data: {"id":"r","model":"actual","choices":[{"delta":{"content":"text"}}]}\n\n'
    + 'data: {"id":"r","model":"actual","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n'
    + 'data: [DONE]\n\n';
  expect(await new OpenAIProvider("requested", { baseURL, apiKey: "secret" }).stream("prompt", [], 100)).toBe("text");
  expect(await receipts()).toMatchObject([{ operation: "stream", model: "actual", requestId: "request-1", inputTokens: 100, outputTokens: 20 }]);
});

it.each([true, false])("retains one incomplete OpenAI receipt on stream failure (usage=%s)", async (withUsage) => {
  contentType = "text/event-stream";
  wireBody = 'data: {"id":"r","model":"actual","choices":[{"delta":{"content":"text"}}]}\n\n'
    + (withUsage ? 'data: {"id":"r","model":"actual","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":30}}}\n\n' : "")
    + 'data: {"error":{"message":"stream interrupted","type":"server_error"}}\n\n';
  await expect(new OpenAIProvider("requested", { baseURL, apiKey: "secret" }).stream("prompt", [], 100)).rejects.toThrow("stream interrupted");
  const events = await receipts();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ provider: "openai", operation: "stream", model: "actual", responseId: "r",
    inputTokens: withUsage ? 100 : null, outputTokens: withUsage ? 20 : null, usageComplete: false });
  if (withUsage) expect(events[0]).toMatchObject({ cacheReadTokens: 60, cacheWriteTokens: 30 });
});

it.each([true, false])("retains Anthropic stream usage (failed=%s)", async (failed) => {
  contentType = "text/event-stream";
  wireBody = 'event: message_start\ndata: {"type":"message_start","message":{"id":"r","type":"message","role":"assistant","model":"actual","content":[],"usage":{"input_tokens":100,"output_tokens":1}}}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null,"stop_sequence":null},"usage":{"output_tokens":20}}\n\n'
    + (failed ? 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"failure"}}\n\n'
      : 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  const result = new AnthropicProvider("requested", { baseURL, apiKey: "secret" }).stream("prompt", [], 100);
  if (failed) await expect(result).rejects.toThrow();
  else await expect(result).resolves.toBe("");
  expect(await receipts()).toMatchObject([{ operation: "stream", model: "actual", requestId: "request-1", inputTokens: 100, outputTokens: 20, usageComplete: !failed }]);
});

it("does not record usage unless the host opts in", async () => {
  vi.stubEnv("LLMWIKI_USAGE_DIRECTORY", undefined);
  payload = { model: "model", choices: [{ message: { content: "text" } }] };
  expect(await new OpenAIProvider("model", { baseURL, apiKey: "secret" }).complete("prompt", [], 100)).toBe("text");
  expect(await receipts()).toEqual([]);
});

it("rejects missing execution identity before constructing a usable provider", () => {
  vi.stubEnv("LLMWIKI_USAGE_EXECUTION_ID", undefined);
  expect(() => new OpenAIProvider("model", { baseURL, apiKey: "secret" })).toThrow("execution id");
});

it("does not retry model work when receipt storage fails", async () => {
  payload = { model: "model", choices: [{ message: { content: "text" } }] };
  vi.stubEnv("LLMWIKI_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_MODEL", "model");
  vi.stubEnv("OPENAI_API_KEY", "secret");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  const file = path.join(directory, "file");
  await writeFile(file, "not a directory");
  vi.stubEnv("LLMWIKI_USAGE_DIRECTORY", file);
  await expect(callClaude({ system: "prompt", messages: [], maxTokens: 100 })).rejects.toMatchObject({ nonRetryable: true });
  expect(requestCount).toBe(1);
});

it.each([null, undefined])("preserves available Converse output when input is %s", async (inputTokens) => {
  payload = { output: { message: { content: [{ text: "text" }] } }, stopReason: "end_turn",
    usage: { inputTokens, outputTokens: 2 } };
  const provider = new ConverseProvider({ model: "model", baseURL, apiKey: "secret", requestTimeoutMs: 1000, toolChoice: "any" });
  await provider.complete("prompt", [], 100);
  expect(await receipts()).toMatchObject([{ inputTokens: null, outputTokens: 2, usageComplete: false }]);
});

it.each([-1, "15", 1.5])("rejects malformed Converse input (%s) even without output usage", async (inputTokens) => {
  payload = { output: { message: { content: [{ text: "text" }] } }, stopReason: "end_turn", usage: { inputTokens } };
  const provider = new ConverseProvider({ model: "model", baseURL, apiKey: "secret", requestTimeoutMs: 1000, toolChoice: "any" });
  await expect(provider.complete("prompt", [], 100)).rejects.toMatchObject({ nonRetryable: true });
  expect(await receipts()).toEqual([]);
});

it("records Converse stream metadata before rejecting unfinished output", async () => {
  contentType = "application/vnd.amazon.eventstream";
  wireBody = Buffer.concat([
    converseEvent("messageStop", { stopReason: "max_tokens" }),
    converseEvent("metadata", { usage: { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 60 } }),
  ]);
  const provider = new ConverseProvider({ model: "model", baseURL, apiKey: "secret", requestTimeoutMs: 1000, toolChoice: "any" });
  await expect(provider.stream("prompt", [], 100)).rejects.toThrow();
  expect(await receipts()).toMatchObject([{ operation: "stream", inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, usageComplete: true }]);
});

it("retains one incomplete Converse receipt when iteration fails after usage", async () => {
  contentType = "application/vnd.amazon.eventstream";
  wireBody = Buffer.concat([
    converseEvent("metadata", { usage: { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 60 } }),
    converseEvent("internalServerException", { message: "stream interrupted" }),
  ]);
  const provider = new ConverseProvider({ model: "model", baseURL, apiKey: "secret", requestTimeoutMs: 1000, toolChoice: "any" });
  await expect(provider.stream("prompt", [], 100)).rejects.toThrow();
  const events = await receipts();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ provider: "converse", operation: "stream", inputTokens: 100,
    outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null, usageComplete: false });
});

it("records Voyage embedding tokens before validating vectors", async () => {
  vi.stubEnv("VOYAGE_API_KEY", "secret");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: [], usage: { total_tokens: 42 }, model: "voyage-model",
  }))));
  await expect(voyageEmbed("private source", "voyage-model")).rejects.toThrow();
  expect(await receipts()).toMatchObject([{ provider: "voyage", operation: "embed", inputTokens: 42, outputTokens: 0 }]);
});

/** Read the durable public receipt format, independent of provider implementation. */
async function receipts(): Promise<Array<Record<string, unknown>>> {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
}
