/**
 * @file test/storage/context-semantic-binding.test.ts
 * @description The context pack's semantic step over read bindings. This file
 * uses `retrieveSemanticChunksFrom`, which exists only after the step was given
 * bindings, so it has NO before-edit run and is not part of
 * `context-semantic-legacy.test.ts`.
 *
 * V1 to V3 pass an in-memory `LivePageReads` and two counted load functions.
 * The page text exists nowhere on disk, the directories belong to no project,
 * and the function under test takes no project root. The store's CACHED chunk
 * text is deliberately wrong, and every expected hash is computed here from the
 * page text, so a hit can only be right if it was read live. The read side
 * answers the confined page read and throws from anything else.
 *
 * V1 also shows the lookup runs on the CONTEXT surface: the typed page opts out
 * of search and is still returned. V2 shows the two loads are lazy. V3a to V3c
 * show the two error boundaries: a store load failure rejects, a profile load
 * failure resolves as a warning. V3c records behaviour as it is, NOT as it
 * ought to be: the provider-failure pattern is applied to a profile error too.
 * V4 is the positive control on real files, with literal expected values. Its
 * beta page is absent, so that chunk is dropped before ranking and is not stale.
 *
 * The objects here are test doubles. They are not a hosted store, not an
 * access-control layer, not `ProjectStore`, and the two load functions are not
 * a storage interface.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { retrieveSemanticChunksFrom } from "../../src/context/retrieval.js";
import { loadProfile } from "../../src/profile/load.js";
import type { LoadedProfile, ProfilePack } from "../../src/profile/types.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { loadEmbeddingsForContext, type EmbeddingLoadOutcome } from "../../src/utils/embeddings-load.js";
import { resolveEmbeddingModel, type EmbeddingStoreV3 } from "../../src/utils/embeddings-store.js";
import { diskLivePageReads, type LivePageReads } from "../../src/utils/page-registry.js";
import * as providerMod from "../../src/utils/provider.js";
import { hashChunkText } from "../../src/utils/retrieval.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const wiki = useTempRoot(["wiki/field-notes"]);
const PROMPT = "zzz";
/** A typed `notes` namespace that opts OUT of search and INTO context. */
const notesIn = (directory: string): ProfilePack => ({
  schemaVersion: 1, profileId: "context", entities: { notes: { directory, retrieval: { includeInSearch: false, includeInContext: true } } },
});
const PROFILE: LoadedProfile = { profile: notesIn("vault/notes"), loadedFrom: null, digest: "" };

/** The memory project: page id to where it lives and its body. */
const LIVE = new Map<string, { at: string; body: string }>([
  ["concepts/alpha", { at: "wiki/concepts/alpha", body: "ALPHA fact about tides." }],
  ["concepts/beta", { at: "wiki/concepts/beta", body: "BETA fact about tides." }],
  ["notes/n-one", { at: "vault/notes/n-one", body: "NOTE fact about tides." }],
]);
const OPENS = ["open wiki/concepts", "open wiki/queries", "open vault/notes"];
const textAt = (at: string): string | undefined => {
  const page = [...LIVE.values()].find((candidate) => candidate.at === at);
  return page && `---\ntitle: ${path.posix.basename(at)}\nsummary: s\n---\n\n${page.body}\n`;
};

type Chunk = NonNullable<EmbeddingStoreV3["chunks"]>[number];
/** A store chunk for a live page. Its cached text is wrong on purpose; `contentHash` defaults to the live hash. */
const chunkFor = (pageId: string, vector: number[], contentHash = hashChunkText(LIVE.get(pageId)!.body)): Chunk =>
  ({ pageId, title: "CACHED TITLE", chunkIndex: 0, contentHash, text: "CACHED TEXT", vector, updatedAt: "t" });
const CHUNKS = [chunkFor("concepts/alpha", [1, 0]), chunkFor("concepts/beta", [0.9, 0.1], "WRONG CACHED HASH"), chunkFor("notes/n-one", [0.6, 0.8])];
const usable = async (): Promise<EmbeddingLoadOutcome> =>
  ({ store: { version: 3, model: "memory", dimensions: 2, entries: [], chunks: CHUNKS }, warnings: [], stalePageIds: [] });

/** The whole slim hit for a live page: LIVE text, the hash of that text, any score. */
const hitFor = (pageId: string) => {
  const { body } = LIVE.get(pageId)!;
  return { pageId, slug: pageId.split("/")[1], text: body, score: expect.any(Number), contentHash: hashChunkText(body) };
};
const nothing = (warning: string | null) => ({ hits: [], warning, staleEntriesDetected: false });

/** Live page reads over {@link LIVE}. Each open and each page read is appended to `log` as one line. */
function memory(log: string[]): LivePageReads {
  const readConfinedPage: LegacyLocalReads["readConfinedPage"] = async (directory, stem) => {
    log.push(`read ${directory}/${stem}`);
    const content = textAt(`${directory}/${stem}`);
    return content === undefined ? { dropped: "escapes-dir" } : { content };
  };
  const reads = new Proxy({ readConfinedPage } as LegacyLocalReads, {
    get: (answered, method) => Reflect.get(answered, method) ?? (() => { throw new Error(`${String(method)} reached`); }),
  });
  const scans: LivePageReads["scans"] = {
    openEntityDirectory: async (directory) => {
      if (!OPENS.includes(`open ${directory}`)) return { status: "invalid" };
      log.push(`open ${directory}`);
      const held = [...LIVE.values()].map((page) => page.at).filter((at) => path.posix.dirname(at) === directory);
      return { status: "ok", directory: {
        listNames: async () => held.map((at) => `${path.posix.basename(at)}.md`),
        resolveEntry: async (name) => path.posix.join(directory, path.posix.basename(name, ".md")),
        readPrefix: async (at, maxBytes) => Buffer.from(textAt(at)!).subarray(0, maxBytes),
        readText: async (at) => textAt(at)!,
      } };
    },
  };
  return { reads, scans };
}

/** Two counted load functions; the profile load answers {@link PROFILE} unless told otherwise. */
const loadsOf = (embeddings: () => Promise<EmbeddingLoadOutcome>, profile: () => Promise<LoadedProfile> = async () => PROFILE) =>
  ({ embeddings: vi.fn(embeddings), profile: vi.fn(profile) });

/** Make the active provider embed every prompt to [1, 0], and return the call counter. */
function provider(): ReturnType<typeof vi.fn> {
  const embed = vi.fn(async () => [1, 0]);
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed, embedBatch: embed } as unknown as ReturnType<typeof providerMod.getProvider>);
  return embed;
}

/** Run the step with a profile load that rejects with `message`; assert nothing after that load ran. */
async function afterProfileFailure(message: string): Promise<unknown> {
  const embed = provider();
  const log: string[] = [];
  const loads = loadsOf(usable, async () => { throw new Error(message); });
  const outcome = await retrieveSemanticChunksFrom(memory(log), loads, PROMPT, 8);
  expect([loads.embeddings.mock.calls.length, loads.profile.mock.calls.length, log, embed.mock.calls.length]).toEqual([1, 1, [], 0]);
  return outcome;
}

describe("the context semantic step over live page reads", () => {
  it("V1 reads from memory on the context surface: LIVE text, a search-excluded typed page, a stale chunk flagged, and nothing else asked", async () => {
    const embed = provider();
    const log: string[] = [];
    const loads = loadsOf(usable);
    expect(await retrieveSemanticChunksFrom(memory(log), loads, PROMPT, 8)).toEqual({
      hits: [hitFor("concepts/alpha"), hitFor("notes/n-one")], warning: null, staleEntriesDetected: true,
    });
    expect(log).toEqual([
      ...OPENS, "read wiki/concepts/alpha", "read wiki/concepts/alpha", "read wiki/concepts/beta", "read vault/notes/n-one", "read vault/notes/n-one",
    ]);
    expect([loads.embeddings.mock.calls, loads.profile.mock.calls, embed.mock.calls]).toEqual([[[]], [[]], [[PROMPT, "query"]]]);
  });

  it("V2 is lazy: a zero limit calls neither load, and a missing store never loads the profile", async () => {
    const embed = provider();
    const log: string[] = [];
    const idle = loadsOf(usable);
    expect(await retrieveSemanticChunksFrom(memory(log), idle, PROMPT, 0)).toEqual(nothing(null));
    expect([idle.embeddings.mock.calls.length, idle.profile.mock.calls.length]).toEqual([0, 0]);
    const storeless = loadsOf(async () => ({ store: null, warnings: [{ code: "embedding-store-unavailable", message: "m" }], stalePageIds: [] }));
    expect(await retrieveSemanticChunksFrom(memory(log), storeless, PROMPT, 8)).toEqual(nothing("embedding-store-missing"));
    expect([storeless.embeddings.mock.calls.length, storeless.profile.mock.calls.length]).toEqual([1, 0]);
    expect(log).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("V3a a rejecting store load REJECTS with its own message, and nothing after it runs", async () => {
    const embed = provider();
    const log: string[] = [];
    const loads = loadsOf(async () => { throw new Error("store load exploded"); });
    await expect(retrieveSemanticChunksFrom(memory(log), loads, PROMPT, 8)).rejects.toHaveProperty("message", "store load exploded");
    expect([loads.embeddings.mock.calls.length, loads.profile.mock.calls.length, log, embed.mock.calls.length]).toEqual([1, 0, [], 0]);
  });

  it("V3b a rejecting profile load RESOLVES as semantic-retrieval-error, and the lookup is never reached", async () => {
    expect(await afterProfileFailure("profile is malformed")).toEqual(nothing("semantic-retrieval-error"));
  });

  it("V3c INCUMBENT, not endorsed: a profile failure whose text names a token RESOLVES as query-embedding-unavailable", async () => {
    expect(await afterProfileFailure("profile token expired")).toEqual(nothing("query-embedding-unavailable"));
  });

  it("V4 runs the same step on real files, a typed page included, with the two real loaders passed as functions", async () => {
    await writeProfileFile(wiki.dir, notesIn("wiki/field-notes"));
    await fs.writeFile(path.join(wiki.dir, "wiki/concepts/alpha.md"), textAt("wiki/concepts/alpha")!);
    await fs.writeFile(path.join(wiki.dir, "wiki/field-notes/n-one.md"), textAt("vault/notes/n-one")!);
    const onDisk = { version: 3, model: resolveEmbeddingModel(), dimensions: 2, entries: [], chunks: CHUNKS };
    await fs.writeFile(path.join(wiki.dir, ".llmwiki/embeddings.json"), JSON.stringify(onDisk));
    provider();
    const loads = { embeddings: () => loadEmbeddingsForContext(wiki.dir), profile: () => loadProfile(wiki.dir) };
    expect(await retrieveSemanticChunksFrom(diskLivePageReads(wiki.dir), loads, PROMPT, 8)).toEqual({
      hits: [
        { pageId: "concepts/alpha", slug: "alpha", text: "ALPHA fact about tides.", score: expect.any(Number), contentHash: hashChunkText("ALPHA fact about tides.") },
        { pageId: "notes/n-one", slug: "n-one", text: "NOTE fact about tides.", score: expect.any(Number), contentHash: hashChunkText("NOTE fact about tides.") },
      ],
      warning: null, staleEntriesDetected: false,
    });
  });
});
