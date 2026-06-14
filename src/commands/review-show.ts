/**
 * Commander action for `llmwiki review show <id>`.
 *
 * Prints a single candidate's metadata header followed by its full body so
 * reviewers can read the proposed page before approving or rejecting.
 */

import { loadCandidateOrFail } from "../compiler/candidates.js";
import * as output from "../utils/output.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Reasons to show for a candidate (guaranteed non-empty by the IO boundary). */
function candidateReasons(candidate: ReviewCandidate): string[] {
  return candidate.heldReasons
    .map((reason) => reason.detail ? `${reason.code} (${reason.detail})` : reason.code);
}

/** Print review metadata added by policy-aware candidate generation. */
function printReviewMetadata(candidate: ReviewCandidate): void {
  output.status("i", output.dim(`review:    ${candidate.reviewMode}`));
  output.status("i", output.dim(`reasons:   ${candidateReasons(candidate).join(", ")}`));
  if (candidate.okfPath) {
    output.status("i", output.dim(`okfPath:   ${candidate.okfPath}`));
  }
  if (candidate.confidence !== undefined) {
    output.status("i", output.dim(`confidence: ${candidate.confidence}`));
  }
  if (candidate.contradicted !== undefined) {
    output.status("i", output.dim(`contradicted: ${candidate.contradicted}`));
  }
}

/** Print a single candidate's full content to stdout. */
export default async function reviewShowCommand(id: string): Promise<void> {
  const candidate = await loadCandidateOrFail(process.cwd(), id);
  if (!candidate) return;

  output.header(`Candidate ${candidate.id}`);
  output.status("i", output.dim(`title:      ${candidate.title}`));
  output.status("i", output.dim(`slug:       ${candidate.slug}`));
  output.status("i", output.dim(`summary:    ${candidate.summary}`));
  output.status("i", output.dim(`sources:    ${candidate.sources.join(", ")}`));
  output.status("i", output.dim(`generated:  ${candidate.generatedAt}`));
  printReviewMetadata(candidate);

  console.log();
  console.log(candidate.body);

  if (candidate.schemaViolations && candidate.schemaViolations.length > 0) {
    console.log();
    output.header("Schema violations");
    for (const v of candidate.schemaViolations) {
      output.status("!", output.warn(`[${v.severity}] ${v.message}`));
    }
  }

  if (candidate.provenanceViolations && candidate.provenanceViolations.length > 0) {
    console.log();
    output.header("Provenance violations");
    for (const v of candidate.provenanceViolations) {
      output.status("!", output.warn(`[${v.severity}] ${v.message}`));
    }
  }
}
