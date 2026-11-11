/**
 * @file test/storage/search-journey-legacy.test.ts
 * @description The search journey through its ROOT functions (`pickSearchRefs`
 * then `loadSelectedRefs`) on real files in a temp directory, for four whole
 * results the existing search tests do not state literally. The file says what
 * composing that journey over read bindings must not change, so it is run byte
 * for byte against the source both before and after that change.
 *
 * J2 records behaviour as it is, NOT as it ought to be: when the chunk lookup
 * finds only stale entries and the page lookup then finds a fresh page, the
 * stale ids the chunk lookup saw are discarded and no stale warning is
 * reported. The two stale lists are not merged. That is pinned here so a
 * refactor cannot quietly change it; it is not endorsed.
 *
 * The embedding provider and the selector model are stubbed. Nothing is
 * injected into the code under test. Every project is the fixture's temp root.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { loadSelectedRefs, pickSearchRefs } from "../../src/search/retrieval.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import * as providerMod from "../../src/utils/provider.js";
import { stubSelectPages } from "../fixtures/fallback-stub.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { pageEntryOf } from "../fixtures/typed-grounding.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const project = useTempRoot();
const PAGE = (title: string, summary: string): string => `---\ntitle: ${title}\nsummary: ${summary}\n---\n\nBody of ${title}.\n`;
const STALE_WARNING = {
  code: "embedding-entry-stale",
  message: "Some embedding entries are stale (their page changed or was removed); rebuild with 'llmwiki compile'.",
};

/** Write one file under the project, creating its directory. */
async function put(relative: string, content: string): Promise<void> {
  const file = path.join(project.dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Write a v3 store stamped with the active embedding model. */
const putStore = (entries: EmbeddingStoreV3["entries"], chunks: EmbeddingStoreV3["chunks"]): Promise<void> =>
  put(".llmwiki/embeddings.json", JSON.stringify({ version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries, chunks }));

/** Make every query embed to the unit vector, and return the call counter. */
function stubEmbedding(): ReturnType<typeof vi.fn> {
  const embed = vi.fn(async () => [1, 0]);
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed, embedBatch: embed } as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

describe("the search journey through its root functions, as it behaves today", () => {
  it("J1 returns the fresh page, reports the stale entry once and ignores an entry with no page", async () => {
    await put("wiki/concepts/fresh.md", PAGE("Fresh", "fs"));
    await put("wiki/concepts/drift.md", PAGE("Drift", "ds"));
    const drift = { ...pageEntryOf("concepts/drift", "Drift", "ds", [0.9, 0.1]), embeddingTextHash: "stale" };
    await putStore([pageEntryOf("concepts/ghost", "Ghost", "gs", [1, 0]), drift, pageEntryOf("concepts/fresh", "Fresh", "fs", [1, 0])], []);
    const embed = stubEmbedding();
    expect(await pickSearchRefs(project.dir, "q")).toEqual({
      refs: [{ pageId: "concepts/fresh", slug: "fresh", title: "Fresh", kind: "page" }], warnings: [STALE_WARNING],
    });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("J2 INCUMBENT, not endorsed: stale chunks then a clean fresh page give a page ref and NO stale warning", async () => {
    await put("wiki/concepts/alpha.md", PAGE("Alpha", "as"));
    const staleChunk = { pageId: "concepts/alpha", title: "Alpha", chunkIndex: 0, contentHash: "STALE", text: "cached", vector: [1, 0], updatedAt: "t" };
    await putStore([pageEntryOf("concepts/alpha", "Alpha", "as", [1, 0])], [staleChunk]);
    const embed = stubEmbedding();
    expect(await pickSearchRefs(project.dir, "q")).toEqual({
      refs: [{ pageId: "concepts/alpha", slug: "alpha", title: "Alpha", kind: "page" }], warnings: [],
    });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("J3 falls back to the selector with no store: picks in order, unknown picks dropped, one outdated warning", async () => {
    await put("wiki/concepts/c.md", PAGE("C", "sc"));
    await put("wiki/queries/q.md", PAGE("Q", "sq"));
    await stubSelectPages(["queries/q", "concepts/ghost", "nope", "concepts/c"]);
    expect(await pickSearchRefs(project.dir, "q")).toEqual({
      refs: [
        { pageId: "queries/q", slug: "q", title: "Q", kind: "index" },
        { pageId: "concepts/c", slug: "c", title: "C", kind: "index" },
      ],
      warnings: [{ code: "embedding-index-outdated", message: "No embedding index found." }],
    });
  });

  it("J4 hydrates selected refs to literal records in ref order and drops one whose page is gone", async () => {
    await put("wiki/concepts/c.md", PAGE("C", "sc"));
    await put("wiki/queries/q.md", PAGE("Q", "sq"));
    await stubSelectPages(["queries/q", "concepts/c"]);
    const { refs } = await pickSearchRefs(project.dir, "q");
    await fs.rm(path.join(project.dir, "wiki/queries/q.md"));
    expect(await loadSelectedRefs(project.dir, refs)).toEqual([{ slug: "c", title: "C", summary: "sc", body: "Body of C." }]);
    await put("wiki/queries/q.md", PAGE("Q", "sq"));
    expect((await loadSelectedRefs(project.dir, refs)).map((record) => record.slug)).toEqual(["q", "c"]);
  });
});
