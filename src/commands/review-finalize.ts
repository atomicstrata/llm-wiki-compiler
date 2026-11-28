/**
 * Shared review approval tail for both single and batch approvals. Callers hold
 * the project lock across page writes, this tail, and candidate cleanup. The
 * page journal does not cover these derived artifacts; retained candidates and
 * write-ahead embedding intent let an interrupted tail be retried without losing
 * collateral page IDs. One batch performs each global pass once.
 *
 * ONE BODY, EXPLICIT STEPS. {@link finalizeReviewApprovalsWith} is the body. It
 * is handed {@link ReviewFinalizeSteps}: the state record's read and single write,
 * resolution, repair, the index, the MOC and the two embeddings refreshes — each
 * a whole DOMAIN step of its own owner, none a raw storage port. The root
 * {@link finalizeReviewApprovals} keeps its signature and passes
 * {@link localReviewFinalizeSteps}, which call the incumbents at call time with
 * exactly their old arguments, so every module spy on them still intercepts.
 * The body keeps every decision of this tail, which DIFFERS from compile's: the
 * source state is persisted FIRST, resolution and repair run only when some
 * candidate is not a validated answer, the write-ahead intent records collateral
 * ids before each write, `affected-only` refuses an incomplete handoff where
 * `drain` does not, and the intent is cleared only at the very end.
 */

import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { repairAndApplyLinks } from "../compiler/link-repair.js";
import { refreshEmbeddingsDrainingPending, refreshAffectedEmbeddings } from "../utils/embeddings-refresh.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { readState, writeState } from "../utils/state.js";
import type { ReviewCandidate, SourceState, WikiState } from "../utils/types.js";
import type { PageId } from "../utils/page-id.js";
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

/** The whole steps the review tail composes; none is storage. */
export interface ReviewFinalizeSteps {
  /** Local: `readState(root)`. */
  readState(root: string): Promise<WikiState>;
  /** The single state write. Local: `writeState(root, state)`. */
  writeState(root: string, state: WikiState): Promise<void>;
  /** Local: `resolveAndApplyLinks(root, changedSlugs, newSlugs, beforeApply)`. */
  resolveLinks(root: string, changedSlugs: string[], newSlugs: string[], beforeApply: ((ids: string[]) => Promise<void>) | undefined): Promise<PageId[]>;
  /** Local: `repairAndApplyLinks(root, beforeApply)`. */
  repairLinks(root: string, beforeApply: ((ids: string[]) => Promise<void>) | undefined): Promise<PageId[]>;
  /** Local: `generateIndex(root)`. */
  generateIndex(root: string): Promise<void>;
  /** Local: `generateMOC(root)`. */
  generateMOC(root: string): Promise<void>;
  /** Local: `refreshEmbeddingsDrainingPending(root, pageIds)`. */
  refreshDraining(root: string, pageIds: PageId[]): Promise<void>;
  /** Whether all work reached durable retry state. Local: `refreshAffectedEmbeddings(root, pageIds)`. */
  refreshAffected(root: string, pageIds: PageId[]): Promise<boolean>;
}

/** LOCAL. The incumbent steps, called at call time with their old arguments; frozen. In no package index. */
const localReviewFinalizeSteps: ReviewFinalizeSteps = Object.freeze({
  readState: (root: string) => readState(root),
  writeState: (root: string, state: WikiState) => writeState(root, state),
  resolveLinks: (root: string, changedSlugs: string[], newSlugs: string[], beforeApply: ((ids: string[]) => Promise<void>) | undefined) =>
    resolveAndApplyLinks(root, changedSlugs, newSlugs, beforeApply),
  repairLinks: (root: string, beforeApply: ((ids: string[]) => Promise<void>) | undefined) => repairAndApplyLinks(root, beforeApply),
  generateIndex: (root: string) => generateIndex(root),
  generateMOC: (root: string) => generateMOC(root),
  refreshDraining: (root: string, pageIds: PageId[]) => refreshEmbeddingsDrainingPending(root, pageIds),
  refreshAffected: (root: string, pageIds: PageId[]) => refreshAffectedEmbeddings(root, pageIds),
});

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
  return finalizeReviewApprovalsWith(localReviewFinalizeSteps, root, candidates, timings, options);
}

/** THE ONE BODY of {@link finalizeReviewApprovals}, over the steps it is handed. */
export async function finalizeReviewApprovalsWith(
  steps: ReviewFinalizeSteps,
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
  await timeReviewPhase(timings, "sourceState", () => persistApprovedSourceStates(steps, root, candidates));
  if (candidates.some((candidate) => !isValidatedAnswer(candidate))) {
    await timeReviewPhase(timings, "resolveLinks", async () => {
      const changed = await steps.resolveLinks(root, slugs, slugs, beforeApply);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
    await timeReviewPhase(timings, "repairLinks", async () => {
      const changed = await steps.repairLinks(root, beforeApply);
      if (embeddingScope === "affected-only") for (const id of changed) pageIds.add(id);
    });
  }
  await timeReviewPhase(timings, "index", () => steps.generateIndex(root));
  await timeReviewPhase(timings, "moc", () => steps.generateMOC(root));
  await timeReviewPhase(timings, "embeddings", async () => {
    if (embeddingScope === "drain") await steps.refreshDraining(root, [...pageIds]);
    else if (!(await steps.refreshAffected(root, [...pageIds]))) {
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
async function persistApprovedSourceStates(steps: ReviewFinalizeSteps, root: string, candidates: ReviewCandidate[]): Promise<void> {
  if (!candidates.some(carriesDefaultSourceState)) return;
  const state = await steps.readState(root);
  mergeApprovedSourceStates(state, candidates);
  await steps.writeState(root, state);
}

/** True for an approved default-page candidate that carries source state to record. */
function carriesDefaultSourceState(candidate: ReviewCandidate): boolean {
  return !candidate.targetEntityType && candidate.sourceStates !== undefined;
}

/**
 * Fold the source state of approved default-page candidates into `state`, in
 * place. Pure with respect to storage: this command persists the state.
 *
 * @returns Whether any candidate contributed.
 */
export function mergeApprovedSourceStates(state: WikiState, candidates: readonly ReviewCandidate[]): boolean {
  const defaults = candidates.filter(carriesDefaultSourceState);
  for (const candidate of defaults) {
    for (const [source, entry] of Object.entries(candidate.sourceStates!)) {
      state.sources[source] = approvedSourceState(state.sources[source], candidate.slug, entry.hash);
    }
  }
  return defaults.length > 0;
}

/** Preserve extraction only when approval leaves a co-owner's hash and concept set unchanged. */
function approvedSourceState(existing: SourceState | undefined, slug: string, hash: string): SourceState {
  const concepts = existing?.concepts ?? [];
  const merged = [...new Set([...concepts, slug])];
  const unchanged = existing?.hash === hash && merged.length === concepts.length;
  return {
    hash,
    concepts: merged,
    compiledAt: new Date().toISOString(),
    ...(unchanged && existing?.extraction ? { extraction: existing.extraction } : {}),
  };
}
