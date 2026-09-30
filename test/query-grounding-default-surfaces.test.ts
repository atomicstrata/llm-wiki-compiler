/**
 * @file test/query-grounding-default-surfaces.test.ts
 * @description The query grounding and embedding-fallback defaults hold on the
 * programmatic surfaces with no options passed: the MCP `query_wiki` and
 * `search_pages` tools and the SDK `query` and `search` methods.
 *
 * Each project has a live page-level embedding store whose embedder fails (the
 * keyless configuration), so retrieval must reach the embedder and then degrade
 * to fallback selection. For queries, the selection call also deletes one
 * selected page before hydration, so the model never sees it. Its id must not
 * be reported as grounding.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockEmbeddingFailure, useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { buildServer, callTool } from "./fixtures/mcp-test-env.js";
import { writePage } from "./fixtures/write-page.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { QueryResult } from "../src/utils/types.js";

// The selection call (tools present) runs the configured side effect, then
// picks both pages; the answer call echoes the prompt the model was shown.
const state = vi.hoisted(() => ({ onSelect: undefined as (() => Promise<void>) | undefined }));
vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async (opts: { tools?: unknown[]; messages: Array<{ content: string }> }) => {
    if (!opts.tools) return opts.messages[0].content;
    await state.onSelect?.();
    return JSON.stringify({ pages: ["concepts/alpha", "concepts/ghost"], reasoning: "r" });
  }),
}));

const seedAlpha = useAlphaPageFixture("grounding-defaults", true);

// Credentials let the surfaces' provider checks pass; the store is stamped
// with this provider's embedding model so it loads and the embedder is reached.
beforeEach(() => {
  process.env.LLMWIKI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
});
afterEach(() => {
  state.onSelect = undefined;
  delete process.env.LLMWIKI_PROVIDER;
  delete process.env.OPENAI_API_KEY;
});

/** Seed alpha (with its page store) plus a ghost page deleted during selection. */
async function seedProject(): Promise<string> {
  const root = await seedAlpha();
  const ghost = path.join(root, "wiki/concepts");
  await writePage(ghost, "ghost", { title: "Ghost", summary: "g" }, "GHOST_BODY fact.");
  state.onSelect = () => rm(path.join(ghost, "ghost.md"));
  return root;
}

/** Warning codes carried by a surface result. */
function codes(result: { warnings?: Array<{ code: string }> }): string[] {
  return (result.warnings ?? []).map((warning) => warning.code);
}

/** Assert both defaults on a query result from any surface. */
function expectDefaults(result: QueryResult, embed: ReturnType<typeof mockEmbeddingFailure>): void {
  expect(embed, "the embedding path was never reached").toHaveBeenCalled();
  expect(result.answer).toContain("ALPHA_BODY");
  expect(result.answer).not.toContain("GHOST_BODY");
  expect(result.pageIds, "a page the model never saw is reported as grounding").toEqual(["concepts/alpha"]);
  expect(result.selectedPages).toEqual(["alpha"]);
  expect(codes(result)).toEqual(expect.arrayContaining(["embedding-degraded", "page-hydration-dropped"]));
}

/** Assert the fallback default on a search result from any surface. */
function expectSearchFallback(
  result: { refs: Array<{ pageId: string }>; warnings?: Array<{ code: string }> },
  embed: ReturnType<typeof mockEmbeddingFailure>,
): void {
  expect(embed, "the embedding path was never reached").toHaveBeenCalled();
  expect(result.refs.map((ref) => ref.pageId)).toContain("concepts/alpha");
  expect(codes(result)).toContain("embedding-degraded");
}

describe("query defaults on the programmatic surfaces", () => {
  it("MCP query_wiki falls back and reports only the hydrated grounding", async () => {
    const root = await seedProject();
    const embed = mockEmbeddingFailure();
    const envelope = await callTool(buildServer(root), "query_wiki", { question: "what is alpha?" });
    expectDefaults((envelope.structuredContent?.result ?? JSON.parse(envelope.content[0].text)) as QueryResult, embed);
  });

  it("SDK query falls back and reports only the hydrated grounding", async () => {
    const root = await seedProject();
    const embed = mockEmbeddingFailure();
    expectDefaults(await createWiki({ root }).query("what is alpha?"), embed);
  });

  it("SDK query still rejects when strict embedding errors are requested", async () => {
    const root = await seedProject();
    mockEmbeddingFailure();
    await expect(createWiki({ root }).query("what is alpha?", { embeddingFailure: "throw" }))
      .rejects.toThrow("no embedding credentials");
  });
});

describe("search defaults on the programmatic surfaces", () => {
  it("MCP search_pages falls back with the embedding-degraded warning", async () => {
    const root = await seedAlpha();
    const embed = mockEmbeddingFailure();
    const envelope = await callTool(buildServer(root), "search_pages", { question: "what is alpha?" });
    expectSearchFallback(envelope.structuredContent?.result ?? JSON.parse(envelope.content[0].text), embed);
  });

  it("SDK search falls back by default and rejects when strict", async () => {
    const root = await seedAlpha();
    const embed = mockEmbeddingFailure();
    const wiki = createWiki({ root });
    expectSearchFallback(await wiki.search("what is alpha?"), embed);
    await expect(wiki.search("what is alpha?", { embeddingFailure: "throw" })).rejects.toThrow("no embedding credentials");
  });
});
