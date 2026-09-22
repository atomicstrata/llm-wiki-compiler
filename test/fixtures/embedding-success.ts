/** Offline embedding-core success for pending-drain integration witnesses. */
import { vi } from "vitest";
import * as embeddings from "../../src/utils/embeddings.js";

/** Capture every requested id and acknowledge all of them without a provider call. */
export function mockEmbeddingSuccess() {
  return vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockImplementation(async (_root, ids) => ({ embedded: ids, eligible: ids, pruned: [] }));
}
