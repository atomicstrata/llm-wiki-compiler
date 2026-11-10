/**
 * Receipt failures must stop retrieval before another paid request is sent.
 * Real providers use a loopback API and live page/chunk stores so these tests
 * cover accounting publication, chunk-to-page fallback, and LLM fallback together.
 */
import { createServer, type Server } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateAnswer } from "../src/commands/query.js";
import { pickSearchRefs } from "../src/search/retrieval.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { resolveEmbeddingFingerprint, resolveEmbeddingModel } from "../src/utils/embeddings-store.js";
import { useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { chunkOf, pageEntryOf } from "./fixtures/typed-grounding.js";
import { listenLoopback, closeLoopback } from "./fixtures/loopback-http.js";

const seedRoot = useAlphaPageFixture("usage-retrieval");
const consumers = [
  { name: "query", run: generateAnswer },
  { name: "search", run: pickSearchRefs },
];
let server: Server;
let root: string;
let requests: string[];

beforeEach(async () => {
  requests = [];
  root = await seedRoot();
  server = createServer(async (request, response) => {
    requests.push(request.url!);
    for await (const _chunk of request) { /* Drain the request. */ }
    const payload = request.url === "/embeddings"
      ? { model: "embedding", data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 12 } }
      : { model: "chat", choices: [{ message: { content: JSON.stringify({ pages: ["concepts/alpha"], reasoning: "r" }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 } };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  const baseURL = await listenLoopback(server);
  vi.stubEnv("LLMWIKI_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_MODEL", "chat");
  vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "embedding");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("OPENAI_EMBEDDINGS_BASE_URL", baseURL);
  vi.stubEnv("LLMWIKI_USAGE_DIRECTORY", path.join(root, "receipts"));
  vi.stubEnv("LLMWIKI_USAGE_EXECUTION_ID", "retrieval-test");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeLoopback(server);
});

/** Seed both fallback candidates; omitting chunks starts at page-level retrieval. */
async function seedStore(withChunks: boolean): Promise<void> {
  const store = { version: 3, model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint(), dimensions: 2,
    entries: [pageEntryOf("concepts/alpha", "Alpha", "a", [1, 0])],
    chunks: withChunks ? [chunkOf("concepts/alpha", "ALPHA_BODY fact.", [1, 0])] : [] };
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki/embeddings.json"), JSON.stringify(store));
}

it.each(consumers)("$name stops after the first failed receipt, with or without chunks", async ({ run }) => {
  const receiptPath = path.join(root, "receipts");
  await writeFile(receiptPath, "not a directory");
  for (const withChunks of [true, false]) {
    requests = [];
    await seedStore(withChunks);
    await expect(run(root, "what is alpha?"))
      .rejects.toMatchObject({ name: "UsageAccountingError", message: "Could not persist provider usage", nonRetryable: true });
    expect(requests).toEqual(["/embeddings"]);
    expect(await readFile(receiptPath, "utf8")).toBe("not a directory");
  }
});

it.each(consumers)("$name rejects invalid receipt configuration before any request", async ({ run }) => {
  await seedStore(true);
  vi.stubEnv("LLMWIKI_USAGE_EXECUTION_ID", undefined);
  await expect(run(root, "what is alpha?"))
    .rejects.toMatchObject({ name: "UsageAccountingError", nonRetryable: true });
  expect(requests).toEqual([]);
});

it.each(consumers)("$name still falls back for ordinary nonRetryable embedding errors", async ({ run }) => {
  await seedStore(true);
  const embed = vi.spyOn(OpenAIProvider.prototype, "embed")
    .mockRejectedValue(Object.assign(new Error("embedding unavailable"), { nonRetryable: true }));
  const result = await run(root, "what is alpha?");
  expect(embed).toHaveBeenCalledTimes(run === generateAnswer ? 2 : 1);
  expect(result.warnings?.map(warning => warning.code)).toContain("embedding-degraded");
  expect(requests).toEqual(Array(run === generateAnswer ? 2 : 1).fill("/chat/completions"));
  expect(await readdir(path.join(root, "receipts"))).toHaveLength(requests.length);
});
