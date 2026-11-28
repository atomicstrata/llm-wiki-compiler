/**
 * @file Whole-store generation checks for the host-driven SDK operation.
 * Query pins the same bytes the retrieval loader consumes. Compile checks
 * that the persisted index covers the live pages and chunks after execution.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { loadProfile } from "../profile/load.js";
import { journalHealth } from "../trust/journal-health.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { INDEX_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../utils/constants.js";
import { collectEligibleLivePages } from "../utils/embeddings-collect.js";
import { migrateEmbeddingStore, type EligibleLivePage } from "../utils/embeddings-migrate.js";
import { readStoredEmbeddings, type ParsedStore } from "../utils/embeddings-storage.js";
import { validateV3ForSearch, type EmbeddingStoreV3 } from "../utils/embeddings-store.js";
import { readPendingMarker } from "../utils/pending-embeddings.js";
import { CompilerOperationError } from "./compiler-model-scope.js";
import type { CompilerOperationModels, CompilerQueryGeneration } from "./compiler-operation-types.js";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** Both retry markers must be readable and hold no work. */
async function retryMarkersClear(root: string): Promise<boolean> {
  const markers = await Promise.all([
    readPendingMarker(root), readPendingMarker(root, QUARANTINED_EMBEDDINGS_FILE),
  ]);
  return markers.every((marker) => marker.status !== "unavailable" && marker.entries.length === 0);
}

/** Require a valid v3 store from the requested vector space. */
function storeProblem({ version, store }: ParsedStore, embedding: CompilerOperationModels["embedding"]): string | undefined {
  if (version !== 3) return "retrieval_index_outdated";
  const validation = validateV3ForSearch({ version, store });
  if (!validation.available || validation.droppedIds.length > 0) return "retrieval_index_unavailable";
  if (store.fingerprint !== embedding.fingerprint || store.dimensions !== embedding.dimensions) return "retrieval_index_mismatch";
  return undefined;
}

/** Check the index authority bytes using the confined read path. */
async function verifyIndex(root: string, expected: string): Promise<void> {
  const indexPath = path.join(root, INDEX_FILE);
  const read = await readConfinedLeafBuffer(root, indexPath, path.dirname(indexPath), MAX_INDEX_BYTES);
  if (read.kind === "absent") throw new CompilerOperationError("retrieval_index_absent");
  if (read.kind !== "ok") throw new CompilerOperationError("retrieval_index_unavailable");
  if (createHash("sha256").update(read.body).digest("hex") !== expected) {
    throw new CompilerOperationError("retrieval_index_mismatch");
  }
}

/** Open and validate the nonempty whole-store generation before the first query effect. */
export async function readCompilerQueryStore(
  root: string,
  generation: CompilerQueryGeneration,
  embedding: CompilerOperationModels["embedding"],
): Promise<EmbeddingStoreV3> {
  if ((await journalHealth(root)).status !== "ok") throw new CompilerOperationError("retrieval_journal_unhealthy");
  await verifyIndex(root, generation.indexSha256);
  const read = await readStoredEmbeddings(root, { digest: true });
  if (read.kind === "absent") throw new CompilerOperationError("retrieval_index_absent");
  if (read.kind !== "parsed") throw new CompilerOperationError("retrieval_index_unavailable");
  if (read.sha256 !== generation.storeSha256) throw new CompilerOperationError("retrieval_index_mismatch");
  const problem = storeProblem(read.parsed, embedding);
  if (problem) throw new CompilerOperationError(problem);
  const store = read.parsed.store as unknown as EmbeddingStoreV3;
  if (store.entries.length === 0) throw new CompilerOperationError("retrieval_index_absent");
  if (!(await retryMarkersClear(root))) throw new CompilerOperationError("retrieval_index_outdated");
  return store;
}

/** Migration verifies stored hashes; this also proves that no eligible chunk is missing. */
function coversEveryChunk(store: EmbeddingStoreV3, pages: EligibleLivePage[]): boolean {
  const byPage = new Map<string, Set<number>>();
  for (const { pageId, chunkIndex } of store.chunks ?? []) {
    const indexes = byPage.get(pageId) ?? new Set<number>();
    indexes.add(chunkIndex);
    byPage.set(pageId, indexes);
  }
  return pages.every(({ pageId, chunkContentHashes }) =>
    (byPage.get(pageId)?.size ?? 0) === chunkContentHashes.length);
}

/** Require a settled journal and complete coverage of eligible live pages and chunks. */
export async function compilerStoreIsComplete(
  root: string,
  embedding: CompilerOperationModels["embedding"],
): Promise<boolean> {
  if ((await journalHealth(root)).status !== "ok" || !(await retryMarkersClear(root))) return false;
  const pages = await collectEligibleLivePages(root, await loadProfile(root));
  const read = await readStoredEmbeddings(root);
  if (read.kind === "absent") return pages.length === 0;
  if (read.kind !== "parsed" || storeProblem(read.parsed, embedding)) return false;
  const { store, reembedPageIds } = migrateEmbeddingStore(read.parsed, pages, embedding.model);
  return reembedPageIds.length === 0 && coversEveryChunk(store, pages);
}
