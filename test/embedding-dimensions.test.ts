/** Explicit vector dimensions are enforced at the real embedding HTTP boundary. */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getEmbeddingProvider } from "../src/utils/embedding-provider.js";
import { listenLoopback, closeLoopback } from "./fixtures/converse-http.js";

let server: Server;
let requests: { dimensions?: number }[];
let size: number;

beforeEach(async () => {
  requests = [];
  size = 3;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ index: 0, embedding: Array(size).fill(1) }] }));
  });
  vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
  vi.stubEnv("OPENAI_EMBEDDINGS_BASE_URL", await listenLoopback(server));
  vi.stubEnv("OPENAI_EMBEDDINGS_API_KEY", "synthetic");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLMWIKI_EMBEDDING_DIMENSIONS", "3");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeLoopback(server);
});

it("requests dimensions for single and batch calls", async () => {
  const provider = getEmbeddingProvider();
  expect(await provider.embed("synthetic")).toHaveLength(3);
  expect(await provider.embedBatch?.(["synthetic"])).toEqual([[1, 1, 1]]);
  expect(requests.map((request) => request.dimensions)).toEqual([3, 3]);
});

it("rejects vectors when the endpoint ignores the requested size", async () => {
  size = 4;
  const provider = getEmbeddingProvider();
  await expect(provider.embed("synthetic")).rejects.toThrow("requested 3");
  await expect(provider.embedBatch?.(["synthetic"])).rejects.toThrow("requested 3");
});

it("rejects invalid dimensions before sending content", async () => {
  vi.stubEnv("LLMWIKI_EMBEDDING_DIMENSIONS", "-1");
  await expect(async () => getEmbeddingProvider().embed("synthetic")).rejects.toThrow("positive integer");
  expect(requests).toEqual([]);
});
