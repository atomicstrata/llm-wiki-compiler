/**
 * Shared review approval tail for both single and batch approvals. Callers hold
 * the project lock across page writes, this tail, and candidate cleanup. The
 * page journal does not cover these derived artifacts; retained candidates let
 * an interrupted tail be retried. One batch performs each global pass once.
 */

import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { repairAndApplyLinks } from "../compiler/link-repair.js";
import { refreshEmbeddingsDrainingPending, refreshAffectedEmbeddings } from "../utils/embeddings-refresh.js";
import type { EmbeddingRefreshScope } from "../utils/embeddings.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { readState, writeState } from "../utils/state.js";
import type { ReviewCandidate } from "../utils/types.js";
import { isValidatedAnswer } from "./review-publication.js";

/** Timings in milliseconds for the shared, ordered approval tail. */
export interface ReviewFinalizeTimings {
  sourceState: number;
  resolveLinks: number;
  repairLinks: number;
  index: number;
  moc: number;
  embeddings: number;
}

/** Run and time a phase, preserving its elapsed time even when it throws. */
export async function timeReviewPhase<T extends object, K extends keyof T>(
  timings: T,
  phase: K,
  run: () => Promise<unknown>,
): Promise<void> {
  const started = performance.now();
  try {
    await run();
  } finally {
    timings[phase] = (performance.now() - started) as T[K];
  }
}

/** Update shared sources and derived wiki artifacts once for all approved pages. */
export async function finalizeReviewApprovals(
  root: string,
  candidates: ReviewCandidate[],
  timings: Partial<ReviewFinalizeTimings> = {},
  embeddingScope: EmbeddingRefreshScope = "drain",
): Promise<void> {
  if (candidates.length === 0) return;
  const slugs = [...new Set(candidates.map((candidate) => candidate.slug))];
  const pageIds = new Set(candidates.map((candidate) => qualifiedPageId(candidatePageNamespace(candidate), candidate.slug)));
  await timeReviewPhase(timings, "sourceState", () => persistApprovedSourceStates(root, candidates));
  if (candidates.some((candidate) => !isValidatedAnswer(candidate))) {
    await timeReviewPhase(timings, "resolveLinks", async () => {
      const changed = await resolveAndApplyLinks(root, slugs, slugs);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
    await timeReviewPhase(timings, "repairLinks", async () => {
      const changed = await repairAndApplyLinks(root);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
  }
  await timeReviewPhase(timings, "index", () => generateIndex(root));
  await timeReviewPhase(timings, "moc", () => generateMOC(root));
  const refresh = embeddingScope === "drain" ? refreshEmbeddingsDrainingPending : refreshAffectedEmbeddings;
  await timeReviewPhase(timings, "embeddings", () => refresh(root, [...pageIds]));
}

/** Resolve the actual promotion namespace, including malformed legacy directory metadata. */
export function candidatePageNamespace(candidate: ReviewCandidate): string {
  return candidate.targetEntityType || (candidate.targetDirectory === "queries" ? "queries" : "concepts");
}

/** Merge only approved default slugs into current live source state with one write. */
async function persistApprovedSourceStates(root: string, candidates: ReviewCandidate[]): Promise<void> {
  const defaults = candidates.filter((candidate) => !candidate.targetEntityType && candidate.sourceStates);
  if (defaults.length === 0) return;
  const state = await readState(root);
  for (const candidate of defaults) {
    for (const [source, entry] of Object.entries(candidate.sourceStates!)) {
      const concepts = state.sources[source]?.concepts ?? [];
      state.sources[source] = {
        hash: entry.hash,
        concepts: [...new Set([...concepts, candidate.slug])],
        compiledAt: new Date().toISOString(),
      };
    }
  }
  await writeState(root, state);
}
