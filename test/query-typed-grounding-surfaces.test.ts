/**
 * @file test/query-typed-grounding-surfaces.test.ts
 * @description F1 surface coverage — the MCP `query_wiki` tool and the SDK
 * `query` method carry the qualified `pageId` (plus a derived display slug) in
 * their result payloads, so a typed `papers/foo` semantic hit is addressable by
 * its qualified id across both programmatic surfaces (not just the CLI).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer, callTool } from "./fixtures/mcp-test-env.js";
import { chunkOf, mockQueryVector, seedTypedProject, writeChunkStore } from "./fixtures/typed-grounding.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { QueryResult } from "../src/utils/types.js";

vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async (opts: { messages: Array<{ content: string }> }) => opts.messages[0].content),
}));

const BODY = "TYPED_BODY about scaling.";

/** Build a project whose ONLY semantic hit is the typed `papers/foo`. */
async function buildTypedProject(): Promise<string> {
  // Set the provider env BEFORE stamping the store model so `resolveEmbeddingModel`
  // is consistent between the on-disk store and the load-time gate.
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  const root = await seedTypedProject("qsurf", "foo", BODY);
  await writeChunkStore(root, [chunkOf("papers/foo", BODY, [1, 0])]);
  mockQueryVector([1, 0]);
  return root;
}

afterEach(() => {
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
});

describe("query typed grounding surfaces — F1 MCP + SDK", () => {
  it("MCP query_wiki payload carries the qualified papers/foo id", async () => {
    const root = await buildTypedProject();
    const server = buildServer(root);
    const envelope = await callTool(server, "query_wiki", { question: "scaling?" });
    const result = (envelope.structuredContent?.result ?? JSON.parse(envelope.content[0].text)) as QueryResult;
    expect(result.pageIds).toContain("papers/foo");
    expect(result.answer).toContain(BODY);
  });

  it("SDK query payload carries the qualified papers/foo id and a display slug", async () => {
    const root = await buildTypedProject();
    const wiki = createWiki({ root });
    const result = await wiki.query("scaling?");
    expect(result.pageIds).toContain("papers/foo");
    expect(result.selectedPages).toContain("foo");
    expect(result.answer).toContain(BODY);
  });
});
