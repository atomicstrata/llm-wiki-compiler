/**
 * @file test/storage/query-selection-legacy.test.ts
 * @description Query page selection through its ROOT function,
 * `selectRelevantPages`, on real files in a temp directory, for five whole
 * results the existing query tests reach only through `generateAnswer`. The
 * file says what running that selection over read bindings must not change,
 * so it is run byte for byte against the source both before and after.
 *
 * Q2 makes "scope before ranking" exact: five out-of-scope pages outrank the
 * one in-scope page, and refs are capped at five, so a filter applied after
 * ranking would return nothing. It does not exercise the lookups' own top-K.
 *
 * Q4 records behaviour as it is, NOT as it ought to be: stale ids from the
 * chunk lookup are kept when the page lookup then succeeds, so a stale warning
 * is reported beside a fresh hit. Query unions the two lists; search does not.
 * That is pinned here so a refactor cannot move it; it is not endorsed.
 *
 * The embedding provider and the selector model are stubbed. Nothing is
 * injected into the code under test. Rerank scores are never asserted.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { mocked } from "../mocked.js";
import { selectRelevantPages } from "../../src/commands/query-selection.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import * as output from "../../src/utils/output.js";
import * as providerMod from "../../src/utils/provider.js";
import { stubSelectPages } from "../fixtures/fallback-stub.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { chunkOf, pageEntryOf } from "../fixtures/typed-grounding.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const wiki = useTempRoot();
const bodyOf = (stem: string): string => `${stem.toUpperCase()} fact about harbors.`;
const QUIET = "zzz";

/** Write a concept page whose title is `<Stem> Title` and whose body is {@link bodyOf}. */
async function concept(stem: string): Promise<void> {
  const text = `---\ntitle: ${stem} Title\nsummary: ${stem} summary\n---\n\n${bodyOf(stem)}\n`;
  await fs.writeFile(path.join(wiki.dir, "wiki/concepts", `${stem}.md`), text);
}

/** Write a v3 store stamped with the active embedding model. */
async function store(entries: EmbeddingStoreV3["entries"], chunks: EmbeddingStoreV3["chunks"]): Promise<void> {
  await fs.mkdir(path.join(wiki.dir, ".llmwiki"), { recursive: true });
  const value = { version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries, chunks };
  await fs.writeFile(path.join(wiki.dir, ".llmwiki/embeddings.json"), JSON.stringify(value));
}

/** Stub the embedding provider; `fails` makes every embed call reject. */
function embedding(fails = false): ReturnType<typeof vi.fn> {
  const embed = vi.fn(async () => { if (fails) throw new Error("no embedding credentials"); return [1, 0]; });
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed, embedBatch: embed } as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

const chunkRef = (stem: string) => ({ pageId: `concepts/${stem}`, slug: stem, title: stem, kind: "chunk" });
const fresh = (stem: string, vector: number[]) => pageEntryOf(`concepts/${stem}`, `${stem} Title`, `${stem} summary`, vector);

describe("query page selection through its root function, as it behaves today", () => {
  it("Q1 takes the chunk route: refs titled by slug, live citations, and debug only when asked", async () => {
    await concept("alpha");
    await concept("beta");
    await store([], [chunkOf("concepts/alpha", bodyOf("alpha"), [1, 0]), chunkOf("concepts/beta", bodyOf("beta"), [0.6, 0.8])]);
    embedding();
    const picked = await selectRelevantPages(wiki.dir, QUIET, true);
    expect(picked.refs).toEqual([chunkRef("alpha"), chunkRef("beta")]);
    expect(picked.chunks.map((cited) => [cited.pageId, cited.slug, cited.title, cited.chunkIndex, cited.text])).toEqual([
      ["concepts/alpha", "alpha", "alpha", 0, bodyOf("alpha")], ["concepts/beta", "beta", "beta", 0, bodyOf("beta")],
    ]);
    expect(picked.debug).toMatchObject({ usedChunks: true, reranked: false, chunks: picked.chunks });
    expect(picked.debug?.pages.map((page) => page.pageId)).toEqual(["concepts/alpha", "concepts/beta"]);
    expect(picked.reasoning).toMatch(/^Selected 2 page\(s\) from 2 reranked chunks: concepts\/alpha#0 \(/);
    expect(picked.warnings).toEqual([]);
    expect((await selectRelevantPages(wiki.dir, QUIET, false)).debug).toBeUndefined();
  });

  it("Q2 narrows to the scope BEFORE ranking: one in-scope page survives five that outrank it", async () => {
    const crowd = ["p1", "p2", "p3", "p4", "p5"];
    for (const stem of [...crowd, "target"]) await concept(stem);
    const chunks = crowd.map((stem) => chunkOf(`concepts/${stem}`, bodyOf(stem), [1, 0]));
    await store([], [...chunks, chunkOf("concepts/target", bodyOf("target"), [0.6, 0.8])]);
    embedding();
    const unscoped = await selectRelevantPages(wiki.dir, QUIET, false);
    expect(unscoped.refs.map((ref) => ref.pageId).sort()).toEqual(crowd.map((stem) => `concepts/${stem}`));
    const scoped = await selectRelevantPages(wiki.dir, QUIET, false, ["concepts/target"]);
    expect(scoped.refs).toEqual([chunkRef("target")]);
    const none = await selectRelevantPages(wiki.dir, QUIET, false, []);
    expect(none).toEqual({ refs: [], reasoning: "No eligible pages.", chunks: [], warnings: [] });
  });

  it("Q3 takes the page route: the selector sees ranked live lines and its picks come back in its order", async () => {
    await concept("alpha");
    await concept("beta");
    await store([fresh("beta", [0.6, 0.8]), fresh("alpha", [1, 0])], []);
    embedding();
    await stubSelectPages(["concepts/beta", "nope", "concepts/alpha"]);
    expect(await selectRelevantPages(wiki.dir, QUIET, true)).toEqual({
      refs: [
        { pageId: "concepts/beta", slug: "beta", title: "beta Title", kind: "page" },
        { pageId: "concepts/alpha", slug: "alpha", title: "alpha Title", kind: "page" },
      ],
      reasoning: "test", chunks: [], warnings: [],
    });
    const { callClaude } = await import("../../src/utils/llm.js");
    const prompt = mocked(callClaude).mock.lastCall![0].messages[0]!.content as string;
    expect(prompt).toContain("- **concepts/alpha**: alpha Title — alpha summary\n- **concepts/beta**: beta Title — beta summary");
  });

  it("Q4 INCUMBENT, not endorsed: a stale chunk then a fresh page give a page ref AND a stale warning", async () => {
    await concept("alpha");
    const staleChunk = { ...chunkOf("concepts/alpha", bodyOf("alpha"), [1, 0]), contentHash: "STALE" };
    await store([fresh("alpha", [1, 0])], [staleChunk]);
    const embed = embedding();
    await stubSelectPages(["concepts/alpha"]);
    const picked = await selectRelevantPages(wiki.dir, QUIET, false);
    expect(picked.refs).toEqual([{ pageId: "concepts/alpha", slug: "alpha", title: "alpha Title", kind: "page" }]);
    expect(picked.warnings).toEqual([{
      code: "embedding-entry-stale",
      message: "Some embedding entries are stale (their page changed or was removed); rebuild with 'llmwiki compile'.",
    }]);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("Q5 prints the chunk diagnostic, degrades a page failure by default and rejects when asked to throw", async () => {
    await concept("alpha");
    await store([fresh("alpha", [1, 0])], [chunkOf("concepts/alpha", bodyOf("alpha"), [1, 0])]);
    embedding(true);
    const printed = vi.spyOn(output, "status").mockImplementation(() => {});
    await stubSelectPages(["concepts/alpha"]);
    await expect(selectRelevantPages(wiki.dir, QUIET, false, undefined, { embeddingFailure: "throw" })).rejects.toThrow("no embedding credentials");
    expect(printed).toHaveBeenCalledTimes(1);
    expect(printed).toHaveBeenCalledWith("!", expect.stringContaining("Chunk pre-filter unavailable (no embedding credentials); falling back."));
    expect(await selectRelevantPages(wiki.dir, QUIET, false)).toEqual({
      refs: [{ pageId: "concepts/alpha", slug: "alpha", title: "alpha Title", kind: "index" }],
      reasoning: "test", chunks: [],
      warnings: [{ code: "embedding-degraded", message: "Page-level embedding failed (no embedding credentials); degraded to LLM/index fallback selection." }],
    });
    expect(printed).toHaveBeenCalledTimes(2);
  });
});
