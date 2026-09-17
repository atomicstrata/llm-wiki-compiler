/**
 * Read and plan batch approvals under the caller's project lock. All candidates
 * are read before writes; known validation refusals are individual outcomes,
 * while unexpected storage failures abort the operation. Conflicting target
 * identities are refused as a group so input order cannot decide an overwrite.
 */

import { readCandidate, UnsafeCandidateIdError } from "../compiler/candidates.js";
import { validateWikiPage } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { planTypedCandidate } from "../trust/promote.js";
import { ResourceLimitError } from "../trust/checks.js";
import type { PagePlannedMutation } from "../trust/planner.js";
import type { ReviewCandidate } from "../utils/types.js";
import { connectorPinMatches, isTypedPromotionRefusal, planDefaultCandidateWrite } from "./review-approve.js";
import type { ReviewBatchItem, ReviewBatchCandidateResult } from "./review-batch-types.js";
import { candidatePageNamespace } from "./review-finalize.js";
import { rejectBatchRelationGates } from "./review-batch-gates.js";
import { rejectSourceSnapshotConflicts } from "./review-batch-sources.js";

/** One candidate and its validated mutations, linked to its output entry. */
export interface PlannedReviewApproval {
  candidate: ReviewCandidate;
  planned: PagePlannedMutation[];
  result: ReviewBatchCandidateResult;
}

/** Expected per-candidate refusal; unexpected errors must stop the shared batch. */
class CandidateValidationError extends Error {}

/** Deduplicate IDs and mark ambiguous body pins without silently choosing one. */
export function uniqueBatchItems(items: ReviewBatchItem[]): {
  items: ReviewBatchItem[];
  results: ReviewBatchCandidateResult[];
} {
  const unique = new Map<string, ReviewBatchItem>();
  const conflicts = new Set<string>();
  for (const item of items) {
    const existing = unique.get(item.id);
    if (existing && existing.draftContentHash !== item.draftContentHash) conflicts.add(item.id);
    if (!existing) unique.set(item.id, item);
  }
  return {
    items: [...unique.values()],
    results: [...unique.keys()].map((id) => conflicts.has(id)
      ? { id, status: "conflict", error: "Duplicate ID has conflicting content hashes." }
      : { id, status: "failed" }),
  };
}

/** Plan the valid subset, retaining known refusals and rejecting every target contender. */
export async function planReviewBatch(
  root: string,
  items: ReviewBatchItem[],
  results: ReviewBatchCandidateResult[],
): Promise<PlannedReviewApproval[]> {
  const approvals: PlannedReviewApproval[] = [];
  for (const [index, item] of items.entries()) {
    const result = results[index];
    if (result.status === "conflict") continue;
    const approval = await planOneCandidate(root, item, result);
    if (approval) approvals.push(approval);
  }
  const ungated = await rejectBatchRelationGates(root, rejectTargetConflicts(approvals));
  return rejectSourceSnapshotConflicts(ungated);
}

/** Validate one under-lock candidate without suppressing an unexpected I/O error. */
async function planOneCandidate(
  root: string,
  item: ReviewBatchItem,
  result: ReviewBatchCandidateResult,
): Promise<PlannedReviewApproval | null> {
  try {
    const candidate = await readCandidate(root, item.id);
    if (!candidate) throw new CandidateValidationError("Candidate missing or malformed.");
    if (!candidateHashMatches(candidate, item.draftContentHash)) {
      throw new CandidateValidationError("Content hash missing or stale; re-review required.");
    }
    const planned = candidate.targetEntityType
      ? await planTypedCandidate(root, candidate)
      : await planDefaultCandidate(root, candidate);
    const namespace = candidatePageNamespace(candidate);
    result.pagePath = `wiki/${namespace}/${candidate.slug}.md`;
    return { candidate, planned, result };
  } catch (error) {
    if (!isCandidateRefusal(error)) throw error;
    result.status = "invalid";
    result.error = error.message;
    return null;
  }
}

/** Require connector pins and honor optional body pins for every other candidate. */
function candidateHashMatches(candidate: ReviewCandidate, supplied: string | undefined): boolean {
  if (!connectorPinMatches(candidate, supplied)) return false;
  return supplied === undefined || sha256Text(candidate.body) === supplied;
}

/** Recognize only expected validation errors; never downgrade unknown storage faults. */
function isCandidateRefusal(error: unknown): error is Error {
  return error instanceof CandidateValidationError || error instanceof UnsafeCandidateIdError ||
    error instanceof ResourceLimitError || isTypedPromotionRefusal(error);
}

/** Apply the same default-page title and trust-planner gates as single approval. */
async function planDefaultCandidate(root: string, candidate: ReviewCandidate): Promise<PagePlannedMutation[]> {
  if (!validateWikiPage(candidate.body)) throw new CandidateValidationError("Candidate failed page validation.");
  const planned = await planDefaultCandidateWrite(root, candidate);
  if (planned.length === 0) throw new CandidateValidationError("Candidate blocked by the write planner.");
  return planned;
}

/** Refuse portable target aliases, even if neither target exists on this filesystem. */
function rejectTargetConflicts(approvals: PlannedReviewApproval[]): PlannedReviewApproval[] {
  const counts = new Map<string, number>();
  for (const { result } of approvals) {
    const key = portableTargetKey(result.pagePath!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return approvals.filter(({ result }) => {
    if (counts.get(portableTargetKey(result.pagePath!)) === 1) return true;
    result.status = "conflict";
    result.error = "Multiple candidates target the same wiki page under portable case/Unicode comparison.";
    return false;
  });
}

/**
 * Compare conservatively on every platform: case-sensitive hosts also refuse
 * aliases that could overwrite each other when moved to a case-insensitive or
 * normalization-insensitive filesystem. This key never changes a stored path.
 */
function portableTargetKey(pagePath: string): string {
  return pagePath.normalize("NFD").toLowerCase().toUpperCase().normalize("NFD");
}
