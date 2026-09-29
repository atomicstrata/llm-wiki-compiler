/**
 * Chunk-freshness assertion for embedding recovery tests. Persisted chunk
 * content hashes match the live page only after its current text was embedded,
 * so this observes the durable effect of a refresh rather than retry bookkeeping.
 * Also exposes a page's live content hash, which retry entries are bound to.
 */
import { expect } from "vitest";
import { loadProfile } from "../../src/profile/load.js";
import { collectEligibleLivePages, pageContentHash } from "../../src/utils/embeddings-collect.js";
import { readV3Store } from "./v3-store.js";

/** Assert whether a page's stored chunks were embedded from its current content. */
export async function expectChunksCurrent(root: string, pageId: string, current: boolean): Promise<void> {
  const live = (await collectEligibleLivePages(root, await loadProfile(root))).find(page => page.pageId === pageId)!;
  const stored = (await readV3Store(root))!.chunks!.filter(chunk => chunk.pageId === pageId).map(chunk => chunk.contentHash);
  if (current) expect(stored).toEqual(live.chunkContentHashes);
  else expect(stored).not.toEqual(live.chunkContentHashes);
}

/** The content hash a retry entry for this live page is bound to. */
export async function liveContentHash(root: string, pageId: string): Promise<string> {
  const live = (await collectEligibleLivePages(root, await loadProfile(root))).find(page => page.pageId === pageId);
  if (!live) throw new Error(`${pageId} is not a live eligible page`);
  return pageContentHash(live);
}
