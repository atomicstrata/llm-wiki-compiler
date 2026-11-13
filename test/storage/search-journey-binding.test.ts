/**
 * @file test/storage/search-journey-binding.test.ts
 * @description The search journey over read bindings. This file uses
 * `LivePageReads` and the `…From` forms of the semantic pipeline and of search,
 * which exist only after the journey was composed over bindings, so it has NO
 * before-edit run and is not part of `search-journey-legacy.test.ts`.
 *
 * W1 to W6 pass an in-memory `LivePageReads`. Its page text exists nowhere on
 * disk, its directories belong to no project, and none of the functions under
 * test takes a project root. The store's CACHED title, summary and chunk text
 * are deliberately wrong, so a result can only be right if it was read live.
 * The read double implements the confined page read and nothing else.
 *
 * W3 records behaviour as it is, NOT as it ought to be: a page that is read for
 * its freshness hashes and is gone at the next read is still returned as a
 * hit, with empty live values, and is not counted as stale. Nothing here is a
 * snapshot, and none is claimed. W7 is the positive control on real files.
 *
 * An in-memory object here is a test double. It is not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { mocked } from "../mocked.js";
import { loadProfile } from "../../src/profile/load.js";
import type { LoadedProfile, ProfilePack } from "../../src/profile/types.js";
import { loadSelectedRefsFrom, pickSearchRefsFrom, type LoadedSearchInputs, type SelectedPageRef } from "../../src/search/retrieval.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { journalHealthWarning } from "../../src/trust/journal-health-warning.js";
import { findRelevantChunksV3From, findRelevantPagesV3From, loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import { buildEmbeddingText } from "../../src/utils/embeddings-pages.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { callClaude } from "../../src/utils/llm.js";
import { diskLivePageReads, type LivePageReads } from "../../src/utils/page-registry.js";
import * as providerMod from "../../src/utils/provider.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import { stubSelectPages } from "../fixtures/fallback-stub.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { useTempRoot } from "../fixtures/temp-root.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const project = useTempRoot(["wiki/research-papers"]);
const PAGE = (title: string, summary: string): string => `---\ntitle: ${title}\nsummary: ${summary}\n---\n\nBody of ${title}.\n`;
const liveHash = (title: string, summary: string): string => hashChunkText(buildEmbeddingText({ title, summary }));
const chunkHash = (title: string): string => hashChunkText(splitIntoChunks(`\nBody of ${title}.\n`)[0]!);
const pack = (papersDir: string): ProfilePack => ({
  schemaVersion: 1,
  profileId: "journey",
  entities: {
    papers: { directory: papersDir, retrieval: { includeInSearch: true, includeInContext: true } },
    secrets: { directory: "vault/secrets", retrieval: { includeInSearch: false, includeInContext: true } },
  },
});
const PROFILE: LoadedProfile = { profile: pack("vault/papers"), loadedFrom: null, digest: "" };

/** A memory project: directory, then page stem, then the page's whole text. */
const MEMORY: Record<string, Record<string, string>> = {
  "wiki/concepts": { alpha: PAGE("Alpha", "as"), drift: PAGE("Drift", "ds") },
  "wiki/queries": {},
  "vault/papers": { "p-one": PAGE("Paper One", "ps") },
  "vault/secrets": { "s-one": PAGE("Secret One", "ss") },
};

/** A v3 entry whose CACHED title and summary are wrong on purpose. */
const entry = (pageId: string, embeddingTextHash: string, vector: number[]): EmbeddingStoreV3["entries"][number] =>
  ({ pageId, title: "CACHED TITLE", summary: "CACHED SUMMARY", embeddingTextHash, vector, updatedAt: "t" });
const ENTRIES = [
  entry("concepts/alpha", liveHash("Alpha", "as"), [1, 0]), entry("concepts/drift", "stale", [0.9, 0.1]),
  entry("papers/p-one", liveHash("Paper One", "ps"), [0.5, 0.5]), entry("concepts/ghost", "none", [1, 0]),
];
const CHUNK = { pageId: "concepts/alpha", title: "CACHED TITLE", chunkIndex: 0, contentHash: chunkHash("Alpha"), text: "CACHED TEXT", vector: [1, 0], updatedAt: "t" };
const storeOf = (entries: EmbeddingStoreV3["entries"], chunks: EmbeddingStoreV3["chunks"]): EmbeddingStoreV3 =>
  ({ version: 3, model: "memory", dimensions: 2, entries, chunks });
const inputsOf = (store: EmbeddingStoreV3 | null, over: Partial<LoadedSearchInputs> = {}): LoadedSearchInputs =>
  ({ profile: PROFILE, embeddings: { store, warnings: [], stalePageIds: [] }, journalWarning: null, ...over });
const ALPHA_REF: SelectedPageRef = { pageId: "concepts/alpha", slug: "alpha", title: "Alpha", kind: "page" };
const PAPER_REF: SelectedPageRef = { pageId: "papers/p-one", slug: "p-one", title: "Paper One", kind: "page" };

/** Live page reads over {@link MEMORY}. `servesOnce` names pages that vanish after one read. */
function memoryPages(log: string[][], servesOnce: string[] = []): LivePageReads {
  const refuse = (name: string) => (): never => { throw new Error(`${name} reached`); };
  const served = new Set<string>();
  const reads: LegacyLocalReads = {
    readText: refuse("readText"), exists: refuse("exists"), statNoFollow: refuse("statNoFollow"), listNames: refuse("listNames"),
    realDirectory: refuse("realDirectory"), readConfinedFile: refuse("readConfinedFile"), locate: refuse("locate"),
    readConfinedPage: async (relDir, slug) => {
      log.push(["read", relDir, slug]);
      const gone = served.has(slug) && servesOnce.includes(slug);
      served.add(slug);
      const text = gone ? undefined : MEMORY[relDir]?.[slug];
      return text === undefined ? { dropped: "escapes-dir" } : { content: text };
    },
  };
  const directoryOf = (relDir: string, pages: Record<string, string>) => ({
    listNames: async () => Object.keys(pages).map((stem) => `${stem}.md`),
    resolveEntry: async (name: string) => `mem://${relDir}/${name.slice(0, -3)}`,
    readPrefix: async (at: string, maxBytes: number) => Buffer.from(pages[at.slice(`mem://${relDir}/`.length)]!).subarray(0, maxBytes),
    readText: async (at: string) => pages[at.slice(`mem://${relDir}/`.length)]!,
  });
  const scans: LivePageReads["scans"] = {
    openEntityDirectory: async (relDir) => {
      log.push(["open", relDir]);
      const pages = MEMORY[relDir];
      return pages === undefined ? { status: "invalid" } : { status: "ok", directory: directoryOf(relDir, pages) };
    },
  };
  return { reads, scans };
}

/** Stub the embedding provider; `fails` makes every embed call reject. */
function stubEmbedding(fails = false): ReturnType<typeof vi.fn> {
  const embed = vi.fn(async () => { if (fails) throw new Error("no embedding credentials"); return [1, 0]; });
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed, embedBatch: embed } as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

describe("the search journey over live page reads", () => {
  it("W1 ranks the page route from memory with LIVE titles and summaries, and asks for nothing else", async () => {
    const log: string[][] = [];
    const embed = stubEmbedding();
    const found = await findRelevantPagesV3From(memoryPages(log), storeOf(ENTRIES, []), "search", "q", 5, PROFILE);
    expect(found.hits.map((hit) => [hit.pageId, hit.slug, hit.title, hit.summary])).toEqual([
      ["concepts/alpha", "alpha", "Alpha", "as"], ["papers/p-one", "p-one", "Paper One", "ps"],
    ]);
    expect(found.stalePageIds).toEqual(["concepts/drift"]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ["open", "wiki/concepts"], ["open", "wiki/queries"], ["open", "vault/papers"], ["open", "vault/secrets"],
      ["read", "wiki/concepts", "alpha"], ["read", "wiki/concepts", "alpha"], ["read", "wiki/concepts", "drift"],
      ["read", "vault/papers", "p-one"], ["read", "vault/papers", "p-one"],
    ]);
    const searched = await pickSearchRefsFrom(memoryPages([]), inputsOf(storeOf(ENTRIES, [])), "q");
    expect(searched.refs).toEqual([ALPHA_REF, PAPER_REF]);
    expect(searched.warnings.map((warning) => warning.code)).toEqual(["embedding-entry-stale"]);
  });

  it("W2 takes the chunk route with LIVE text, one embed call per route, and none when nothing is live", async () => {
    const embed = stubEmbedding();
    const pages = memoryPages([]);
    const found = await findRelevantChunksV3From(pages, storeOf([], [CHUNK]), "search", "q", 5, PROFILE);
    expect(found.hits.map((hit) => [hit.pageId, hit.chunkIndex, hit.text, hit.contentHash])).toEqual([
      ["concepts/alpha", 0, "Body of Alpha.", chunkHash("Alpha")],
    ]);
    expect(embed).toHaveBeenCalledTimes(1);
    const searched = await pickSearchRefsFrom(pages, inputsOf(storeOf(ENTRIES, [CHUNK])), "q");
    expect(searched).toEqual({ refs: [{ pageId: "concepts/alpha", slug: "alpha", title: "", kind: "chunk" }], warnings: [] });
    expect(embed).toHaveBeenCalledTimes(2);
    const ghosts = storeOf([entry("concepts/ghost", "none", [1, 0])], [{ ...CHUNK, pageId: "concepts/ghost" }]);
    expect(await findRelevantPagesV3From(pages, ghosts, "search", "q", 5, PROFILE)).toEqual({ hits: [], stalePageIds: [] });
    expect(await findRelevantChunksV3From(pages, ghosts, "search", "q", 5, PROFILE)).toEqual({ hits: [], stalePageIds: [] });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("W3 INCUMBENT, not endorsed: a page gone after its freshness read is kept as a hit with empty live values", async () => {
    stubEmbedding();
    const onlyAlpha = storeOf([ENTRIES[0]!], [CHUNK]);
    const pageRoute = await findRelevantPagesV3From(memoryPages([], ["alpha"]), onlyAlpha, "search", "q", 5, PROFILE);
    expect(pageRoute.hits.map((hit) => [hit.pageId, hit.title, hit.summary])).toEqual([["concepts/alpha", "", ""]]);
    expect(pageRoute.stalePageIds).toEqual([]);
    const chunkRoute = await findRelevantChunksV3From(memoryPages([], ["alpha"]), onlyAlpha, "search", "q", 5, PROFILE);
    expect(chunkRoute.hits.map((hit) => [hit.pageId, hit.text])).toEqual([["concepts/alpha", ""]]);
    expect(chunkRoute.stalePageIds).toEqual([]);
  });

  it("W4 degrades a failed embedding to the fallback by default and rejects when asked to throw", async () => {
    const embed = stubEmbedding(true);
    await stubSelectPages(["concepts/alpha"]);
    const inputs = inputsOf(storeOf(ENTRIES, []));
    await expect(pickSearchRefsFrom(memoryPages([]), inputs, "q", { embeddingFailure: "throw" })).rejects.toThrow("no embedding credentials");
    expect(await pickSearchRefsFrom(memoryPages([]), inputs, "q")).toEqual({
      refs: [{ ...ALPHA_REF, kind: "index" }],
      warnings: [{ code: "embedding-degraded", message: "Semantic retrieval embedding failed (no embedding credentials); degraded to LLM/index fallback selection." }],
    });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("W5 offers the fallback selector only search-eligible pages and keeps the loaded warnings in order", async () => {
    await stubSelectPages(["secrets/s-one", "papers/p-one"]);
    const journalWarning = { code: "incomplete-compile" as const, message: "journal" };
    const outdated = { code: "embedding-index-outdated" as const, message: "older" };
    const inputs = inputsOf(null, { journalWarning, embeddings: { store: null, warnings: [outdated], stalePageIds: [] } });
    const opened: string[][] = [];
    expect(await pickSearchRefsFrom(memoryPages(opened), inputs, "q")).toEqual({ refs: [{ ...PAPER_REF, kind: "index" }], warnings: [journalWarning, outdated] });
    const prompt = mocked(callClaude).mock.lastCall![0].messages[0]!.content as string;
    expect(prompt).toContain("- **papers/p-one**: Paper One — ps");
    expect(prompt).toContain("concepts/alpha");
    expect(prompt).not.toContain("secrets/s-one");
    expect(prompt).not.toContain("Secret One");
    expect(opened).toEqual([["open", "wiki/concepts"], ["open", "wiki/queries"], ["open", "vault/papers"], ["open", "vault/secrets"]]);
  });

  it("W6 hydrates refs from memory to literal records in ref order and drops a page the double lacks", async () => {
    const log: string[][] = [];
    const refs = [PAPER_REF, { ...ALPHA_REF, pageId: "concepts/ghost", slug: "ghost" }, ALPHA_REF];
    expect(await loadSelectedRefsFrom(memoryPages(log), PROFILE, refs)).toEqual([
      { slug: "p-one", title: "Paper One", summary: "ps", body: "Body of Paper One." },
      { slug: "alpha", title: "Alpha", summary: "as", body: "Body of Alpha." },
    ]);
    expect(log).toEqual([["read", "vault/papers", "p-one"], ["read", "wiki/concepts", "ghost"], ["read", "wiki/concepts", "alpha"]]);
  });

  it("W7 runs the same search on real files, a typed page included, from inputs the real loaders produced", async () => {
    const put = (relative: string, text: string): Promise<void> => fs.writeFile(path.join(project.dir, relative), text);
    const papers = pack("wiki/research-papers").entities.papers!;
    await writeProfileFile(project.dir, { schemaVersion: 1, profileId: "journey", entities: { papers } });
    await put("wiki/concepts/alpha.md", PAGE("Alpha", "as"));
    await put("wiki/research-papers/p-one.md", PAGE("Paper One", "ps"));
    await put(".llmwiki/embeddings.json", JSON.stringify({ ...storeOf(ENTRIES, []), model: resolveEmbeddingModel() }));
    stubEmbedding();
    const inputs = {
      profile: await loadProfile(project.dir), embeddings: await loadEmbeddingsForSearch(project.dir),
      journalWarning: await journalHealthWarning(project.dir),
    };
    expect(inputs.embeddings.warnings).toEqual([]);
    expect(await pickSearchRefsFrom(diskLivePageReads(project.dir), inputs, "q")).toEqual({ refs: [ALPHA_REF, PAPER_REF], warnings: [] });
    const records = await loadSelectedRefsFrom(diskLivePageReads(project.dir), inputs.profile, [PAPER_REF]);
    expect(records).toEqual([{ slug: "p-one", title: "Paper One", summary: "ps", body: "Body of Paper One." }]);
  });
});
