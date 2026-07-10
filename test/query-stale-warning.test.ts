/**
 * @file test/query-stale-warning.test.ts
 * @description Acceptance tests for Finding 4 — `generateAnswer` surfaces the
 * `embedding-entry-stale` warning when the v3 read pipeline drops stale store
 * entries, on BOTH the chunk path and the page path. Mirrors the search-side
 * `embeddings-v3-consumers` coverage, but through the query pipeline so MCP/SDK
 * `query_wiki` no longer silently falls back around stale entries.
 *
 * A stale entry is built by writing a store record whose `contentHash` /
 * `embeddingTextHash` deliberately mismatches the LIVE page — the read pipeline
 * drops it and reports its id in `stalePageIds`, which the query path must
 * forward into `QueryResult.warnings`. A clean store adds no such warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmbeddingStoreV3 } from "../src/utils/embeddings-store.js";
import {
  chunkOf,
  echoCallClaudeModule,
  mockQueryVector,
  seedTypedProject,
  writeChunkStore,
  writePageStore,
  pageEntryOf,
} from "./fixtures/typed-grounding.js";

vi.mock("../src/utils/llm.js", () => echoCallClaudeModule());

const BODY = "FOO_BODY about transformer scaling.";

/** Codes surfaced on a `generateAnswer` result over the seeded project. */
async function warningCodes(root: string): Promise<string[]> {
  const { generateAnswer } = await import("../src/commands/query.js");
  const result = await generateAnswer(root, "scaling?");
  return (result.warnings ?? []).map((w) => w.code);
}

/** A chunk record whose `contentHash` is forced wrong → read drops it as stale. */
function staleChunkOf(pageId: string, vec: number[]): EmbeddingStoreV3["chunks"][number] {
  return { pageId, title: pageId, chunkIndex: 0, contentHash: "STALE_HASH", text: "cached", vector: vec, updatedAt: "t" };
}

describe("query stale-embedding warnings — Finding 4", () => {
  beforeEach(() => mockQueryVector([1, 0]));
  afterEach(() => vi.restoreAllMocks());

  it("surfaces embedding-entry-stale when the CHUNK path drops a stale entry", async () => {
    const root = await seedTypedProject("qstale-chunk", "foo", BODY);
    await writeChunkStore(root, [staleChunkOf("papers/foo", [1, 0])]);
    expect(await warningCodes(root)).toContain("embedding-entry-stale");
  });

  it("surfaces embedding-entry-stale when the PAGE path drops a stale entry", async () => {
    const root = await seedTypedProject("qstale-page", "foo", BODY);
    // entry hash computed over the WRONG title → live freshness check fails.
    await writePageStore(root, [pageEntryOf("papers/foo", "WRONG", "s", [1, 0])]);
    expect(await warningCodes(root)).toContain("embedding-entry-stale");
  });

  it("does NOT surface embedding-entry-stale for a clean v3 store", async () => {
    const root = await seedTypedProject("qstale-clean", "foo", BODY);
    await writeChunkStore(root, [chunkOf("papers/foo", BODY, [1, 0])]);
    expect(await warningCodes(root)).not.toContain("embedding-entry-stale");
  });
});
