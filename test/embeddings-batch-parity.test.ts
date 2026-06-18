/**
 * Golden-parity test: batched output equals sequential output (updatedAt stripped).
 *
 * Verifies that enabling embedBatch on the provider yields chunk vectors
 * and ordering that are byte-for-byte identical to the sequential fallback
 * path, proving the slot reconstruction algorithm is correct.
 */

import { describe, it, expect, vi } from "vitest";
import { refreshChunkEmbeddings } from "../src/utils/embeddings-chunks.js";
import * as providerMod from "../src/utils/provider.js";
import type { PageRecord } from "../src/utils/embeddings-pages.js";

const records: PageRecord[] = [
  { slug: "a", title: "A", summary: "", body: "alpha one.\n\nalpha two." },
  { slug: "b", title: "B", summary: "", body: "beta one." },
];

// Deterministic vector keyed by text so order mistakes are visible.
const vecFor = (t: string): number[] => [t.length, t.charCodeAt(0) ?? 0];

const stripTime = (cs: any[]) => cs.map(({ updatedAt, ...rest }) => rest);

describe("golden parity: batched == sequential", () => {
  it("produces the same store with and without embedBatch", async () => {
    const withBatch = { embed: async (t: string) => vecFor(t), embedBatch: async (ts: string[]) => ts.map(vecFor) };
    const noBatch = { embed: async (t: string) => vecFor(t) }; // embedBatch absent -> sequential fallback

    vi.spyOn(providerMod, "getProvider").mockReturnValue(withBatch as any);
    const batched = await refreshChunkEmbeddings(records, [], false, 256);

    vi.spyOn(providerMod, "getProvider").mockReturnValue(noBatch as any);
    const sequential = await refreshChunkEmbeddings(records, [], false, 256);

    expect(stripTime(batched.chunks)).toEqual(stripTime(sequential.chunks)); // vectors, slugs, order, hashes identical
  });
});
