/**
 * Offline embedding-core success for pending-drain integration witnesses. The
 * refresh calls the core's ONE BODY, `updateEmbeddingsLockedCoreFrom`, with its
 * bound writer sources, so that is the seam spied here and matched below.
 */
import { expect, vi } from "bun:test";
import * as embeddings from "../../src/utils/embeddings.js";

/** Capture every requested id and acknowledge all of them without a provider call. */
export function mockEmbeddingSuccess() {
  return vi.spyOn(embeddings, "updateEmbeddingsLockedCoreFrom")
    .mockImplementation(async (_sources, ids) => ({ embedded: ids, eligible: ids, pruned: [] }));
}

/** The bound writer sources a refresh hands its core: the store reads, the profile, the live pages and the store's raw writes. */
export function boundWriterSources() {
  return expect.objectContaining({
    store: expect.objectContaining({ resolvePrivateDir: expect.any(Function), leafKind: expect.any(Function), readLeafBytes: expect.any(Function) }),
    profile: expect.objectContaining({ activeProduct: expect.any(Object), readPrivateLeafText: expect.any(Function) }),
    live: expect.objectContaining({ pages: expect.objectContaining({ isRegularFile: expect.any(Function) }), entities: expect.any(Object) }),
    writes: expect.objectContaining({ createPrivateDir: expect.any(Function), replaceLeaf: expect.any(Function) }),
  });
}
