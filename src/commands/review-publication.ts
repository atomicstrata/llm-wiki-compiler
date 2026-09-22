/**
 * Class-specific approval prechecks run on the authoritative admitted candidate
 * under the existing review lock. Validated answers fail closed and preserve
 * exact bytes; ordinary candidates retain warning-only unavailable behavior.
 */
import type { ReviewCandidate } from "../utils/types.js";
import type { PagePlannedMutation } from "../trust/planner.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { validateCitationPublication } from "../citations/answer-publication.js";
import { genericBrokenTargets } from "../citations/generic-publication.js";
import * as output from "../utils/output.js";

/** Admission has already rejected unknown kinds and orphan/malformed manifests. */
export function isValidatedAnswer(candidate: ReviewCandidate): boolean {
  return candidate.candidateKind?.name === "validated-answer";
}

/** Refuse without mutating the candidate, leaving explicit recovery possible. */
function refuse(candidate: ReviewCandidate, message: string): false {
  output.status("!", output.error(`Candidate ${candidate.id} not approved: ${message}`));
  process.exitCode = 1;
  return false;
}

/** Apply policy only after connector prerequisites and under-lock admission. */
export async function checkCandidatePublication(root: string, candidate: ReviewCandidate): Promise<boolean> {
  if (isValidatedAnswer(candidate)) return checkAnswer(root, candidate);
  if (candidate.targetEntityType) return true;
  // Every other candidate lands in wiki/concepts or wiki/queries at approval
  // (any non-"queries" directory routes to concepts), so the check applies to all.
  let broken: string[];
  try {
    broken = await genericBrokenTargets(root, candidate.body);
  } catch (error) {
    output.status("!", output.warn(`Candidate ${candidate.id}: citation check unavailable (${String(error)}); continuing existing approval policy.`));
    return true;
  }
  return broken.length ? refuse(candidate, `broken citation targets: ${broken.join(", ")}`) : true;
}

/** Digest is an edit detector; current resolution, rather than its observations, authorizes approval. */
async function checkAnswer(root: string, candidate: ReviewCandidate): Promise<boolean> {
  // No default-profile gate here: a reviewed answer is the trust-routed
  // destination and the planner applies the current profile's rules at write.
  if (sha256Text(parseFrontmatter(candidate.body).body) !== candidate.citationManifest!.bodyDigest) {
    return refuse(candidate, "candidate-edited: regenerate and restage the answer.");
  }
  try {
    await validateCitationPublication(root, candidate.body, "approval", candidate.slug);
  } catch (error) {
    return refuse(candidate, `citation validation refused or unavailable: ${String(error)}`);
  }
  return true;
}

/** Check the executor's exact proposed bytes and target before any answer write. */
export function checkAnswerPlan(candidate: ReviewCandidate, planned: PagePlannedMutation[]): boolean {
  if (!isValidatedAnswer(candidate)) return true;
  const [page] = planned;
  if (planned.length !== 1 || page.kind !== "page" || !["create", "update"].includes(page.operation)
    || !("directory" in page.target) || page.target.directory !== "queries" || page.target.slug !== candidate.slug
    || page.body !== candidate.body) return refuse(candidate, "planned answer bytes or target differ from the validated document.");
  if (page.operation === "update") {
    output.status("!", output.warn(`Replacing existing query wiki/queries/${candidate.slug}.md with candidate ${candidate.id}.`));
  }
  return true;
}
