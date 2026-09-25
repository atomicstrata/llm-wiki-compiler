/**
 * Source-snapshot consistency for a proposed review batch. One source-state hash
 * cannot describe pages approved from multiple source revisions. Refuse every
 * contender for an ambiguous source before page writes, rather than selecting a
 * revision by manifest order. Unrelated approvals remain independently usable.
 */

import type { PlannedReviewApproval } from "./review-batch-plan.js";

/** Refuse all default candidates whose shared source snapshots disagree. */
export function rejectSourceSnapshotConflicts(approvals: PlannedReviewApproval[]): PlannedReviewApproval[] {
  const conflicts = conflictingSources(approvals);
  return approvals.filter(({ candidate, result }) => {
    if (candidate.targetEntityType) return true; // Typed pages do not update source state.
    const ambiguous = Object.keys(candidate.sourceStates ?? {}).filter((source) => conflicts.has(source));
    if (ambiguous.length === 0) return true;
    result.status = "conflict";
    result.error = `Conflicting source snapshots: ${ambiguous.sort().join(", ")}. Recompile and review one source revision.`;
    return false;
  });
}

/** Identify hash disagreement without inferring freshness from timestamps or order. */
function conflictingSources(approvals: PlannedReviewApproval[]): Set<string> {
  const hashes = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const { candidate } of approvals) {
    if (candidate.targetEntityType) continue;
    for (const [source, entry] of Object.entries(candidate.sourceStates ?? {})) {
      if (hashes.has(source) && hashes.get(source) !== entry.hash) conflicts.add(source);
      hashes.set(source, entry.hash);
    }
  }
  return conflicts;
}
