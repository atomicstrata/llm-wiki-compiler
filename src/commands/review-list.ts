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
  return candidate.reviewMode;
}

/** Compact reason summary for review list rows. */
function formatReasons(candidate: ReviewCandidate): string {
  return candidate.heldReasons.map((r) => r.code).join(", ");
}

/**
 * Typed-target suffix for a candidate row.
 *
 * Typed candidates (those carrying `targetEntityType`) land in
 * `wiki/<targetEntityType>/` instead of the default `wiki/concepts/`. Surfacing
 * the typed slug keeps the human review gate honest: a staged `papers/foo` must
 * not look identical to a default concept. Default candidates (no
 * `targetEntityType`) return "" so their output stays byte-identical.
 */
function typedTargetSuffix(candidate: ReviewCandidate): string {
  return candidate.targetEntityType
    ? ` → ${candidate.targetEntityType}/${candidate.slug}`
    : "";
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
    const typedTarget = typedTargetSuffix(candidate);
    output.status(
      "?",
      `${output.info(candidate.id)} → ${candidate.slug}${typedTarget} ${meta}`,
    );
  }

  output.status(
    "→",
    output.dim(`Use \`llmwiki review show <id>\` to inspect a candidate.`),
  );
}
