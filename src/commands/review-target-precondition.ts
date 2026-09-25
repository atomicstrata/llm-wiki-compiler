/**
 * Shared under-lock destination checks for single and batch approval. A body
 * pin protects the candidate, not its live destination: proposed repairs must
 * also retain the target hash or absence they observed. Unverifiable targets
 * fail closed, including on retries after a successful page promotion.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { sha256Text } from "../connectors/hash.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Verify the destination still satisfies the proposal's exact preconditions. */
export async function targetUnchangedSincePropose(root: string, candidate: ReviewCandidate): Promise<boolean> {
  if (candidate.expectTargetAbsent && candidate.expectedTargetHash !== undefined) return false;
  if (candidate.expectTargetAbsent) {
    try {
      await readFile(candidateTargetPath(root, candidate), "utf8");
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  if (candidate.expectedTargetHash === undefined) return true;
  try {
    const current = await readFile(candidateTargetPath(root, candidate), "utf8");
    return sha256Text(current) === candidate.expectedTargetHash;
  } catch {
    return false;
  }
}

/** Follow the same typed/default routing as the approval planner. */
function candidateTargetPath(root: string, candidate: ReviewCandidate): string {
  if (candidate.targetEntityType) {
    return path.join(root, "wiki", candidate.targetEntityType, `${candidate.slug}.md`);
  }
  const directory = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  return path.join(root, directory, `${candidate.slug}.md`);
}
