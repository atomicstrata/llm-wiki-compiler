/**
 * @file test/storage/context-semantic-legacy.test.ts
 * @description The context pack's semantic step through its ROOT function,
 * `retrieveSemanticChunks`, on real files in a temp directory. The existing
 * unit test replaces the whole embedding module and the profile loader, so it
 * never reads a page or a store; this file pins five whole results with nothing
 * replaced but the embedding provider. It says what running the step over read
 * bindings must not change, so it is run byte for byte against the source both
 * before and after.
 *
 * C4 shows that the requested limit reaches the chunk lookup: one hit for a
 * limit of one, two for a limit of two. It does NOT exercise the ceiling of
 * thirty, which would need thirty-one fresh chunks, and no case here can tell
 * whether the limit is capped before or after the profile is loaded.
 *
 * Scores are never asserted exactly. Nothing is injected into the code under
 * test.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { retrieveSemanticChunks } from "../../src/context/retrieval.js";
import * as providerMod from "../../src/utils/provider.js";
import { hashChunkText } from "../../src/utils/retrieval.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { chunkOf, writeChunkStore } from "../fixtures/typed-grounding.js";
import { writePage } from "../fixtures/write-page.js";

const wiki = useTempRoot();
const PROMPT = "zzz";
const BODY = { alpha: "ALPHA fact about tides.", beta: "BETA fact about tides." };
type Stem = keyof typeof BODY;

/** Write one concept page whose body is {@link BODY} for its stem. */
const seed = (stem: Stem): Promise<void> =>
  writePage(path.join(wiki.dir, "wiki/concepts"), stem, { title: `${stem} title`, summary: "s" }, BODY[stem]);

/** A store chunk whose hash matches the live page; its cached text is the fixture's "cached". */
const fresh = (stem: Stem, vector: number[]) => chunkOf(`concepts/${stem}`, BODY[stem], vector);

/** Write a v3 chunk store stamped with the active embedding model. */
async function store(chunks: Parameters<typeof writeChunkStore>[1]): Promise<void> {
  await mkdir(path.join(wiki.dir, ".llmwiki"));
  await writeChunkStore(wiki.dir, chunks);
}

/** Make the active provider answer every embed call with `embed`, and return it for counting. */
function provide(embed: () => Promise<number[]>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(embed);
  vi.spyOn(providerMod, "getProvider").mockReturnValue({ embed: spy, embedBatch: spy } as unknown as ReturnType<typeof providerMod.getProvider>);
  return spy;
}
const unit = async (): Promise<number[]> => [1, 0];

/** The whole slim hit for a live page: LIVE text, the hash of that text, any score. */
const hitFor = (stem: Stem) =>
  ({ pageId: `concepts/${stem}`, slug: stem, text: BODY[stem], score: expect.any(Number), contentHash: hashChunkText(BODY[stem]) });
const nothing = (warning: string | null, staleEntriesDetected = false) => ({ hits: [], warning, staleEntriesDetected });

describe("the context semantic step through its root function, as it behaves today", () => {
  it("C1 returns a fresh chunk as the whole slim hit: LIVE text and hash, no warning, no stale flag, one embed call", async () => {
    await seed("alpha");
    await store([fresh("alpha", [1, 0])]);
    const embed = provide(unit);
    expect(await retrieveSemanticChunks(wiki.dir, PROMPT, 8)).toEqual({ hits: [hitFor("alpha")], warning: null, staleEntriesDetected: false });
    expect(embed.mock.calls).toEqual([[PROMPT, "query"]]);
  });

  it("C2 reports embedding-index-outdated when the project has no store, without embedding the prompt", async () => {
    await seed("alpha");
    const embed = provide(unit);
    expect(await retrieveSemanticChunks(wiki.dir, PROMPT, 8)).toEqual(nothing("embedding-index-outdated"));
    expect(embed).not.toHaveBeenCalled();
  });

  it("C3 reports embedding-store-missing WITH the stale flag when the only chunk is stale", async () => {
    await seed("alpha");
    await store([{ ...fresh("alpha", [1, 0]), contentHash: "STALE" }]);
    const embed = provide(unit);
    expect(await retrieveSemanticChunks(wiki.dir, PROMPT, 8)).toEqual(nothing("embedding-store-missing", true));
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("C4 passes the requested limit to the chunk lookup: one hit for a limit of one, two for two", async () => {
    await seed("alpha");
    await seed("beta");
    await store([fresh("beta", [0.6, 0.8]), fresh("alpha", [1, 0])]);
    provide(unit);
    expect((await retrieveSemanticChunks(wiki.dir, PROMPT, 1)).hits).toEqual([hitFor("alpha")]);
    expect((await retrieveSemanticChunks(wiki.dir, PROMPT, 2)).hits).toEqual([hitFor("alpha"), hitFor("beta")]);
  });

  it("C5 resolves with query-embedding-unavailable when the provider rejects with a credentials message", async () => {
    await seed("alpha");
    await store([fresh("alpha", [1, 0])]);
    const embed = provide(async () => { throw new Error("no embedding credentials"); });
    expect(await retrieveSemanticChunks(wiki.dir, PROMPT, 8)).toEqual(nothing("query-embedding-unavailable"));
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
