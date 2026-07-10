/**
 * @file test/embeddings-v3-consumers.test.ts
 * @description Acceptance tests for the consumer-side v3 swap (S6 + degrade).
 *
 * Asserts that the `embedding-index-outdated` degrade warning is surfaced in the
 * RESULT payload (not just a log) across the search refs path and the query
 * pipeline, and that a degraded (non-v3) store degrades search to lexical/index
 * selection rather than crashing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { defaultProfileLoad } from "./fixtures/profile-fixtures.js";

const OUTDATED = { code: "embedding-index-outdated", message: "older" };

/** A healthy v3 load outcome with a minimal usable store (no degrade warning). */
const V3_OK = { store: { version: 3, model: "m", dimensions: 2, entries: [], chunks: [] }, warnings: [], stalePageIds: [] };

// Degrade the embedding load (store: null + outdated warning) so consumers hit
// the index-selection fallback, and stub selectPages so no LLM call is needed.
vi.mock("../src/utils/embeddings-load.js", () => ({
  loadEmbeddingsForSearch: vi.fn(async () => ({ store: null, warnings: [OUTDATED], stalePageIds: [] })),
  findRelevantChunksV3: vi.fn(),
  findRelevantPagesV3: vi.fn(),
}));
vi.mock("../src/commands/page-selection.js", () => ({
  selectPages: vi.fn(async () => ({ pages: [], reasoning: "none" })),
}));
vi.mock("../src/profile/load.js", () => ({
  loadProfile: vi.fn(async () => defaultProfileLoad()),
}));

import { pickSearchRefs } from "../src/search/retrieval.js";
import {
  loadEmbeddingsForSearch,
  findRelevantChunksV3,
  findRelevantPagesV3,
} from "../src/utils/embeddings-load.js";

const mockedLoad = loadEmbeddingsForSearch as unknown as Mock;
const mockedChunks = findRelevantChunksV3 as unknown as Mock;
const mockedPages = findRelevantPagesV3 as unknown as Mock;

afterEach(() => vi.clearAllMocks());

describe("v3 consumers — S6 degrade warnings", () => {
  it("search surfaces embedding-index-outdated in the refs outcome (not a log)", async () => {
    const { refs, warnings } = await pickSearchRefs("/tmp/proj", "anything");
    expect(warnings.map((w) => w.code)).toContain("embedding-index-outdated");
    // Degraded to index selection, which returned no pages — no crash.
    expect(refs).toEqual([]);
  });

  it("search degrades (no throw) and still returns a well-formed outcome on a non-v3 store", async () => {
    const outcome = await pickSearchRefs("/tmp/proj", "q");
    expect(Array.isArray(outcome.refs)).toBe(true);
    expect(Array.isArray(outcome.warnings)).toBe(true);
  });
});

describe("v3 consumers — embedding-entry-stale surfacing (search)", () => {
  const chunkHit = { pageId: "concepts/alpha", slug: "alpha", chunkIndex: 0, contentHash: "h", text: "t", score: 0.9 };
  const pageHit = { pageId: "concepts/alpha", slug: "alpha", title: "A", summary: "s", score: 0.9 };

  /** Run a search over a healthy v3 store and return the surfaced warning codes. */
  async function warningCodesFromSearch(): Promise<string[]> {
    mockedLoad.mockResolvedValueOnce(V3_OK);
    const { warnings } = await pickSearchRefs("/tmp/proj", "q");
    return warnings.map((w) => w.code);
  }

  it("surfaces embedding-entry-stale when the chunk pipeline reports stale entries", async () => {
    mockedChunks.mockResolvedValueOnce({ hits: [chunkHit], stalePageIds: ["concepts/ghost"] });
    expect(await warningCodesFromSearch()).toContain("embedding-entry-stale");
  });

  it("surfaces embedding-entry-stale when the page pipeline reports stale entries", async () => {
    mockedChunks.mockResolvedValueOnce({ hits: [], stalePageIds: [] });
    mockedPages.mockResolvedValueOnce({ hits: [pageHit], stalePageIds: ["concepts/drift"] });
    expect(await warningCodesFromSearch()).toContain("embedding-entry-stale");
  });

  it("surfaces embedding-entry-stale when stale entries leave ZERO hits (index fallback)", async () => {
    // Every scored candidate was stale → no hits → search falls to the LLM fallback.
    mockedChunks.mockResolvedValueOnce({ hits: [], stalePageIds: ["concepts/ghost"] });
    mockedPages.mockResolvedValueOnce({ hits: [], stalePageIds: ["concepts/ghost"] });
    expect(await warningCodesFromSearch()).toContain("embedding-entry-stale");
  });

  it("does NOT surface embedding-entry-stale for a clean v3 store (no stale entries)", async () => {
    mockedChunks.mockResolvedValueOnce({ hits: [chunkHit], stalePageIds: [] });
    expect(await warningCodesFromSearch()).not.toContain("embedding-entry-stale");
  });
});
