/**
 * Shared review approval tail for both single and batch approvals. Callers hold
 * the project lock across page writes, this tail, and candidate cleanup. The
 * page journal does not cover these derived artifacts; retained candidates and
 * write-ahead embedding intent let an interrupted tail be retried without losing
 * collateral page IDs. One batch performs each global pass once.
 */

import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { repairAndApplyLinks } from "../compiler/link-repair.js";
import { refreshEmbeddingsDrainingPending, refreshAffectedEmbeddings } from "../utils/embeddings-refresh.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { readState, writeState } from "../utils/state.js";
import type { ReviewCandidate } from "../utils/types.js";
import { isValidatedAnswer } from "./review-publication.js";
import { openReviewEmbeddingIntent, type ReviewEmbeddingIntent } from "./review-embedding-intent.js";

/** Timings in milliseconds for the shared, ordered approval tail. */
export interface ReviewFinalizeTimings {
  sourceState: number;
  resolveLinks: number;
  repairLinks: number;
  index: number;
  moc: number;
  embeddings: number;
}

/** Scoped finalization requires the same intent session persisted before promotion. */
type ReviewFinalizeOptions =
  | { embeddingScope?: "drain"; intent?: never }
  | { embeddingScope: "affected-only"; intent: ReviewEmbeddingIntent };

/** Validate and persist all initially known work before any candidate page writes. */
export async function prepareReviewEmbeddingIntent(
  root: string,
  candidates: ReviewCandidate[],
): Promise<ReviewEmbeddingIntent> {
  const intent = await openReviewEmbeddingIntent(root, candidates);
  await intent.record(candidates.map(candidate => qualifiedPageId(candidatePageNamespace(candidate), candidate.slug)));
  return intent;
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
  options: ReviewFinalizeOptions = {},
): Promise<void> {
  if (candidates.length === 0) return;
  const slugs = [...new Set(candidates.map((candidate) => candidate.slug))];
  const { intent, embeddingScope = "drain" } = options;
  const pageIds = intent?.pageIds ?? new Set<string>();
  for (const candidate of candidates) pageIds.add(qualifiedPageId(candidatePageNamespace(candidate), candidate.slug));
  const beforeApply = intent ? async (ids: string[]) => {
    await intent.record(ids);
  } : undefined;
  await timeReviewPhase(timings, "sourceState", () => persistApprovedSourceStates(root, candidates));
  if (candidates.some((candidate) => !isValidatedAnswer(candidate))) {
    await timeReviewPhase(timings, "resolveLinks", async () => {
      const changed = await resolveAndApplyLinks(root, slugs, slugs, beforeApply);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
    await timeReviewPhase(timings, "repairLinks", async () => {
      const changed = await repairAndApplyLinks(root, beforeApply);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
  }
  await timeReviewPhase(timings, "index", () => generateIndex(root));
  await timeReviewPhase(timings, "moc", () => generateMOC(root));
  await timeReviewPhase(timings, "embeddings", async () => {
    if (embeddingScope === "drain") await refreshEmbeddingsDrainingPending(root, [...pageIds]);
    else if (!(await refreshAffectedEmbeddings(root, [...pageIds]))) {
      throw new Error("Embedding retry handoff incomplete; review intent and candidates retained for retry.");
    }
  });
  await intent?.clear();
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
