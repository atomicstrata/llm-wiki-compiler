/**
 * @file test/storage/query-selection-binding.test.ts
 * @description Query page selection over read bindings. This file uses
 * `selectRelevantPagesFrom`, which exists only after the selection was given
 * bindings, so it has NO before-edit run and is not part of
 * `query-selection-legacy.test.ts`.
 *
 * M1 to M4 pass an in-memory `LivePageReads`. Its page text exists nowhere on
 * disk, its directories belong to no project, and the function under test
 * takes no project root. The store's CACHED title, summary and chunk text are
 * deliberately wrong, so a result can only be right if it was read live. The
 * read side answers the confined page read and throws from anything else.
 *
 * M2 asserts the WHOLE recorded conversation for a scoped selection: no page
 * outside the scope is ever read for freshness. That shows the scope is
 * applied before the walk. It does not exercise the lookups' own top-K.
 * M6 is the positive control on real files, typed page included.
 *
 * An in-memory object here is a test double. It is not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "bun:test";
import { selectRelevantPagesFrom } from "../../src/commands/query-selection.js";
import { loadProfile } from "../../src/profile/load.js";
import type { LoadedProfile, ProfilePack } from "../../src/profile/types.js";
import type { LoadedSearchInputs } from "../../src/search/retrieval.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { journalHealthWarning } from "../../src/trust/journal-health-warning.js";
import { loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { buildEmbeddingText } from "../../src/utils/embeddings-pages.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { callClaude } from "../../src/utils/llm.js";
import * as output from "../../src/utils/output.js";
import { diskLivePageReads, type LivePageReads } from "../../src/utils/page-registry.js";
import * as providerMod from "../../src/utils/provider.js";
import { hashChunkText } from "../../src/utils/retrieval.js";
import { stubSelectPages } from "../fixtures/fallback-stub.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { useTempRoot } from "../fixtures/temp-root.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const wiki = useTempRoot(["wiki/research-papers"]);
const QUIET = "zzz";
const papersIn = (directory: string): ProfilePack => ({
  schemaVersion: 1, profileId: "query", entities: { papers: { directory, retrieval: { includeInSearch: true, includeInContext: true } } },
});
const PROFILE: LoadedProfile = { profile: papersIn("vault/papers"), loadedFrom: null, digest: "" };

/** The memory project, flat: "<directory>/<stem>" to [title, summary, body]. */
const LIVE: Record<string, [title: string, summary: string, body: string]> = {
  "wiki/concepts/alpha": ["Alpha", "as", "ALPHA fact about harbors."],
  "wiki/concepts/beta": ["Beta", "bs", "BETA fact about harbors."],
  "vault/papers/p-one": ["Paper One", "ps", "PAPER fact about harbors."],
};
const DIRECTORIES = ["wiki/concepts", "wiki/queries", "vault/papers"];
const textOf = (key: string): string | undefined => {
  const page = LIVE[key];
  return page && `---\ntitle: ${page[0]}\nsummary: ${page[1]}\n---\n\n${page[2]}\n`;
};
const ID_OF: Record<string, string> = { "concepts/alpha": "wiki/concepts/alpha", "concepts/beta": "wiki/concepts/beta", "papers/p-one": "vault/papers/p-one" };

/** A v3 chunk and page entry for a live page, with CACHED values that are wrong on purpose. */
const chunkFor = (pageId: string, vector: number[]): NonNullable<EmbeddingStoreV3["chunks"]>[number] =>
  ({ pageId, title: "CACHED TITLE", chunkIndex: 0, contentHash: hashChunkText(LIVE[ID_OF[pageId]!]![2]), text: "CACHED TEXT", vector, updatedAt: "t" });
const entryFor = (pageId: string, vector: number[]): EmbeddingStoreV3["entries"][number] => {
  const [title, summary] = LIVE[ID_OF[pageId]!]!;
  return { pageId, title: "CACHED TITLE", summary: "CACHED SUMMARY", embeddingTextHash: hashChunkText(buildEmbeddingText({ title, summary })), vector, updatedAt: "t" };
};
const CHUNKS = [chunkFor("concepts/alpha", [1, 0]), chunkFor("concepts/beta", [0.9, 0.1]), chunkFor("papers/p-one", [0.5, 0.5])];
const loaded = (entries: EmbeddingStoreV3["entries"], chunks: EmbeddingStoreV3["chunks"], profile = PROFILE): LoadedSearchInputs => ({
  profile, journalWarning: null,
  embeddings: { store: { version: 3, model: "memory", dimensions: 2, entries, chunks }, warnings: [], stalePageIds: [] },
});
const viaChunk = (pageId: string) => ({ pageId, slug: pageId.split("/")[1], title: pageId.split("/")[1], kind: "chunk" });

/** Live page reads over {@link LIVE}; every call is appended to `log` as one line. */
function memory(log: string[]): LivePageReads {
  const anythingElse = new Proxy({}, { get: (_target, method) => () => { throw new Error(`${String(method)} reached`); } });
  const reads = Object.assign(Object.create(anythingElse) as LegacyLocalReads, {
    readConfinedPage: async (directory: string, stem: string) => {
      log.push(`read ${directory}/${stem}`);
      const content = textOf(`${directory}/${stem}`);
      return content === undefined ? { dropped: "escapes-dir" } : { content };
    },
  });
  const stemsIn = (directory: string): string[] => Object.keys(LIVE).filter((key) => path.posix.dirname(key) === directory).map((key) => path.posix.basename(key));
  const scans: LivePageReads["scans"] = {
    openEntityDirectory: async (directory) => {
      log.push(`open ${directory}`);
      if (!DIRECTORIES.includes(directory)) return { status: "invalid" };
      const wholeText = async (locator: string): Promise<string> => textOf(locator)!;
      return { status: "ok", directory: {
        listNames: async () => stemsIn(directory).map((stem) => `${stem}.md`),
        resolveEntry: async (name) => `${directory}/${name.replace(/\.md$/, "")}`,
        readPrefix: async (locator, maxBytes) => Buffer.from(await wholeText(locator)).subarray(0, maxBytes),
        readText: wholeText,
      } };
    },
  };
  return { reads, scans };
}
const OPENS = DIRECTORIES.map((directory) => `open ${directory}`);
const twice = (key: string): string[] => [`read ${key}`, `read ${key}`];

/** Make the active provider embed every query with `embed`. */
const provider = (embed: () => Promise<number[]>): void => {
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed, embedBatch: embed } as unknown as ReturnType<typeof providerMod.getProvider>);
};
const unit = async (): Promise<number[]> => [1, 0];
const broken = async (): Promise<number[]> => { throw new Error("no embedding credentials"); };

describe("query page selection over live page reads", () => {
  it("M1 takes the chunk route from memory: LIVE text, a typed page, debug, and nothing else asked", async () => {
    provider(unit);
    const log: string[] = [];
    const picked = await selectRelevantPagesFrom(memory(log), loaded([], CHUNKS), QUIET, true);
    expect(picked.refs).toEqual([viaChunk("concepts/alpha"), viaChunk("concepts/beta"), viaChunk("papers/p-one")]);
    expect(picked.chunks.map((cited) => [cited.pageId, cited.title, cited.text])).toEqual([
      ["concepts/alpha", "alpha", "ALPHA fact about harbors."], ["concepts/beta", "beta", "BETA fact about harbors."],
      ["papers/p-one", "p-one", "PAPER fact about harbors."],
    ]);
    expect(picked.debug).toMatchObject({ usedChunks: true, reranked: false, chunks: picked.chunks });
    expect(picked.warnings).toEqual([]);
    expect(log).toEqual([...OPENS, ...twice("wiki/concepts/alpha"), ...twice("wiki/concepts/beta"), ...twice("vault/papers/p-one")]);
  });

  it("M2 applies the scope before the walk: no page outside it is ever read", async () => {
    provider(unit);
    const log: string[] = [];
    const picked = await selectRelevantPagesFrom(memory(log), loaded([], CHUNKS), QUIET, false, ["papers/p-one"]);
    expect(picked.refs).toEqual([viaChunk("papers/p-one")]);
    expect(log).toEqual([...OPENS, ...twice("vault/papers/p-one")]);
  });

  it("M3 takes the page route from memory: LIVE titles in the selector prompt and in the refs", async () => {
    provider(unit);
    await stubSelectPages(["papers/p-one", "concepts/alpha"]);
    const entries = [entryFor("papers/p-one", [0.5, 0.5]), entryFor("concepts/alpha", [1, 0])];
    expect(await selectRelevantPagesFrom(memory([]), loaded(entries, []), QUIET, true)).toEqual({
      refs: [
        { pageId: "papers/p-one", slug: "p-one", title: "Paper One", kind: "page" },
        { pageId: "concepts/alpha", slug: "alpha", title: "Alpha", kind: "page" },
      ],
      reasoning: "test", chunks: [], warnings: [],
    });
    const prompt = (callClaude as unknown as Mock<typeof callClaude>).mock.lastCall![0].messages[0]!.content as string;
    expect(prompt).toContain("- **concepts/alpha**: Alpha — as\n- **papers/p-one**: Paper One — ps");
    expect(prompt).not.toContain("CACHED");
  });

  it("M4 falls through a chunk failure, degrades a page failure by default and rejects when asked to throw", async () => {
    provider(broken);
    const printed = vi.spyOn(output, "status").mockImplementation(() => {});
    await stubSelectPages(["concepts/beta"]);
    const inputs = loaded([entryFor("concepts/alpha", [1, 0])], CHUNKS);
    await expect(selectRelevantPagesFrom(memory([]), inputs, QUIET, false, undefined, { embeddingFailure: "throw" })).rejects.toThrow("no embedding credentials");
    expect(printed).toHaveBeenCalledWith("!", expect.stringContaining("Chunk pre-filter unavailable (no embedding credentials); falling back."));
    expect(await selectRelevantPagesFrom(memory([]), inputs, QUIET, false)).toEqual({
      refs: [{ pageId: "concepts/beta", slug: "beta", title: "Beta", kind: "index" }],
      reasoning: "test", chunks: [],
      warnings: [{ code: "embedding-degraded", message: "Page-level embedding failed (no embedding credentials); degraded to LLM/index fallback selection." }],
    });
    expect(printed).toHaveBeenCalledTimes(2);
  });

  it("M6 runs the same selection on real files, a typed page included, from inputs the real loaders produced", async () => {
    await writeProfileFile(wiki.dir, papersIn("wiki/research-papers"));
    await fs.writeFile(path.join(wiki.dir, "wiki/concepts/alpha.md"), textOf("wiki/concepts/alpha")!);
    await fs.writeFile(path.join(wiki.dir, "wiki/research-papers/p-one.md"), textOf("vault/papers/p-one")!);
    const onDisk = { version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries: [], chunks: CHUNKS };
    await fs.writeFile(path.join(wiki.dir, ".llmwiki/embeddings.json"), JSON.stringify(onDisk));
    provider(unit);
    const inputs = {
      profile: await loadProfile(wiki.dir), embeddings: await loadEmbeddingsForSearch(wiki.dir),
      journalWarning: await journalHealthWarning(wiki.dir),
    };
    expect(inputs.embeddings.warnings).toEqual([]);
    const pages = diskLivePageReads(wiki.dir);
    const picked = await selectRelevantPagesFrom(pages, inputs, QUIET, false);
    expect(picked.refs).toEqual([viaChunk("concepts/alpha"), viaChunk("papers/p-one")]);
    expect(picked.chunks.map((cited) => cited.text)).toEqual(["ALPHA fact about harbors.", "PAPER fact about harbors."]);
    expect(picked.warnings).toEqual([]);
    expect((await selectRelevantPagesFrom(pages, inputs, QUIET, false, ["papers/p-one"])).refs).toEqual([viaChunk("papers/p-one")]);
  });
});
