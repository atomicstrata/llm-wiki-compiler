/**
 * Commander action for `llmwiki review list`.
 *
 * Prints every pending review candidate (id, slug, sources, generated time)
 * so reviewers can pick one to inspect with `llmwiki review show <id>`.
 */

import { listCandidates } from "../compiler/candidates.js";
import * as output from "../utils/output.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Human-readable review mode for old and new candidate records. */
function formatMode(candidate: ReviewCandidate): string {
  return candidate.reviewMode ?? "forced";
}

/** Compact reason summary for review list rows. */
function formatReasons(candidate: ReviewCandidate): string {
  const reasons = candidate.heldReasons?.map((r) => r.code) ?? ["manual-review-requested"];
  return reasons.join(", ");
}

/** List every pending candidate from .llmwiki/candidates/. */
export default async function reviewListCommand(): Promise<void> {
  output.header("Pending review candidates");

  const candidates = await listCandidates(process.cwd());
  if (candidates.length === 0) {
    output.status("✓", output.success("No pending candidates."));
    return;
  }

  for (const candidate of candidates) {
    const sources = candidate.sources.join(", ");
    const mode = `${formatMode(candidate)}: ${formatReasons(candidate)}`;
    const meta = output.dim(`${candidate.generatedAt} | ${mode} | sources: ${sources}`);
    output.status("?", `${output.info(candidate.id)} → ${candidate.slug} ${meta}`);
  }

  output.status(
    "→",
    output.dim(`Use \`llmwiki review show <id>\` to inspect a candidate.`),
  );
}
