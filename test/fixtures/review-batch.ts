/**
 * Minimal real candidate fixtures for batch-review tests. Bodies avoid providers
 * and timestamps so filesystem comparisons focus on review and recovery behavior.
 */
import { beforeEach, afterEach, vi } from "vitest";
import { writeCandidate, type CandidateDraft } from "../../src/compiler/candidates.js";
import { approveReviewBatch } from "../../src/commands/review-approve-batch.js";
import type { ReviewBatchItem } from "../../src/commands/review-batch-types.js";

/** Stage a valid default candidate, optionally replacing any draft field. */
export function stageBatchCandidate(root: string, slug: string, overrides: Partial<CandidateDraft> = {}) {
  return writeCandidate(root, {
    title: slug, slug, summary: "", sources: [],
    body: `---\ntitle: ${slug}\n---\n\nBody for ${slug}.\n`,
    ...overrides,
  });
}

/** Execute unique IDs or explicit hash-pinned items through the real batch core. */
export function approveBatch(root: string, ...items: (string | ReviewBatchItem)[]) {
  return approveReviewBatch(root, {
    schemaVersion: 1,
    candidates: items.map((item) => typeof item === "string" ? { id: item } : item),
  });
}

/** Silence progress and disable provider calls unless an individual test enables embeddings. */
export function useQuietBatchTests(): void {
  beforeEach(() => {
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());
}
