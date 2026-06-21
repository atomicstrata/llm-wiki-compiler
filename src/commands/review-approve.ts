/**
 * Commander action for `llmwiki review approve <id>`.
 *
 * Promotes a pending candidate into the live wiki: writes the page body to
 * wiki/concepts/<slug>.md, refreshes the index/MOC, updates embeddings, and
 * removes the candidate file. Approval never re-invokes the LLM — the body
 * stored in the candidate is written verbatim.
 *
 * All mutations are performed under `.llmwiki/lock` to prevent races with a
 * concurrent compile or sibling approve/reject. The candidate is re-read under
 * the lock (TOCTOU guard) — if it disappears between the fast-fail check and
 * lock acquisition (e.g. a concurrent reject ran first), the approval aborts
 * cleanly rather than writing a page from a stale in-memory snapshot.
 */

import path from "path";
import { validateWikiPage } from "../utils/markdown.js";
import { planDefaultPageMutation } from "../trust/planner.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import {
  applyTypedCandidate,
  CandidateProfileError,
  CandidatePromotionBlockedError,
} from "../trust/promote.js";
import { EntityFieldContractError } from "../profile/field-contract.js";
import { deleteCandidate } from "../compiler/candidates.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveLinks } from "../compiler/resolver.js";
import { updateEmbeddings } from "../utils/embeddings.js";
import { readState, updateSourceState } from "../utils/state.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { ReviewCandidate } from "../utils/types.js";
import { runReviewUnderLock, readCandidateUnderLock } from "./review-helpers.js";

/** Approve a pending candidate by promoting its body into wiki/concepts/. */
export default async function reviewApproveCommand(id: string): Promise<void> {
  await runReviewUnderLock(id, approveUnderLock);
}

/**
 * Perform all wiki mutations for an approval while holding the lock.
 *
 * Re-reads the candidate under the lock so that a concurrent reject that ran
 * between the pre-lock fast-fail and lock acquisition is detected. Aborts with
 * exit code 1 if the candidate has disappeared. Page-body validation is routed
 * per target: DEFAULT candidates are gated by the title-requiring
 * {@link validateWikiPage} (in {@link routeDefaultPageWrite}); TYPED candidates
 * skip it and instead rely on {@link applyTypedCandidate}'s profile-aware
 * field-contract validation, since non-default entity types need not require a
 * `title`.
 */
async function approveUnderLock(root: string, id: string): Promise<void> {
  const candidate = await readCandidateUnderLock(root, id);
  if (!candidate) return;

  const pagePath = await routeApprovedPageWrite(root, candidate, id);
  if (!pagePath) return;
  output.status("+", output.success(`Approved → ${output.source(pagePath)}`));

  await persistCandidateSourceStates(root, candidate);
  await refreshWikiAfterApproval(root, candidate.slug);
  await deleteCandidate(root, id);
  output.status("✓", output.dim(`Candidate ${id} cleared.`));
}

/**
 * Route the candidate's page write through the write planner/executor (CLP
 * Invariant 4) and return the ABSOLUTE page path it landed at, or `null` on a
 * refusal (exit code 1, candidate retained, nothing written).
 *
 * A candidate carrying `targetEntityType` (staged via the typed planner) routes
 * through {@link applyTypedCandidate} so it lands at `wiki/<entityType>/<slug>.md`
 * — NOT silently in concepts. A candidate without a typed target keeps the
 * EXISTING default concepts/queries path byte-for-byte. Both run under the
 * ALREADY-HELD review lock (no nested-lock deadlock).
 */
async function routeApprovedPageWrite(
  root: string,
  candidate: ReviewCandidate,
  id: string,
): Promise<string | null> {
  if (candidate.targetEntityType) {
    return routeTypedPageWrite(root, candidate, id);
  }
  return routeDefaultPageWrite(root, candidate, id);
}

/**
 * Route a TYPED candidate through the profile-validated typed planner. Refuses
 * (exit 1, candidate retained) when the project has no profile, the type is no
 * longer declared, the body violates the declared field contract, or the re-plan
 * blocks — never a silent fall back to concepts. Returns the absolute
 * `wiki/<entityType>/<slug>.md` path on success.
 */
async function routeTypedPageWrite(
  root: string,
  candidate: ReviewCandidate,
  id: string,
): Promise<string | null> {
  try {
    const relPath = await applyTypedCandidate(root, candidate);
    return path.join(root, relPath);
  } catch (err) {
    if (
      err instanceof CandidateProfileError ||
      err instanceof CandidatePromotionBlockedError ||
      err instanceof EntityFieldContractError
    ) {
      output.status("!", output.error(`Candidate ${id} not approved: ${err.message}`));
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
}

/**
 * Route a DEFAULT candidate (no typed target) through the concepts/queries
 * planner exactly as before, preserving byte-for-byte parity. The
 * title-requiring {@link validateWikiPage} gate runs HERE — only for default
 * candidates — so a body that fails it is refused with the SAME message and exit
 * code 1 as before. `allowOverwrite` is true so re-approving upserts via
 * `update`. Returns the absolute `wiki/<dir>/<slug>.md` path on success, or
 * `null` on a failed validation / blocked plan.
 */
async function routeDefaultPageWrite(
  root: string,
  candidate: ReviewCandidate,
  id: string,
): Promise<string | null> {
  if (!validateWikiPage(candidate.body)) {
    output.status("!", output.error(`Candidate ${id} failed page validation; not approved.`));
    process.exitCode = 1;
    return null;
  }
  const directory = candidate.targetDirectory === "queries" ? "queries" : "concepts";
  const { planned } = await planDefaultPageMutation({
    root,
    directory,
    slug: candidate.slug,
    body: candidate.body,
    origin: "review",
    reviewRouted: false,
    allowOverwrite: true,
  });
  if (planned.length === 0) {
    output.status("!", output.error(`Candidate ${id} blocked by the write planner; not approved.`));
    process.exitCode = 1;
    return null;
  }
  await applyApprovedMutationsLocked(root, planned);
  const dir = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  return path.join(root, dir, `${candidate.slug}.md`);
}

/**
 * Add the approved concept slug to each contributing source's live-concepts
 * list in state.json.
 *
 * State records only LIVE concepts: held/rejected concepts are never in state,
 * and approval adds exactly the approved slug. This prevents a rejected sibling
 * from leaking into state when its source's first held candidate is approved.
 *
 * Each approval immediately union-adds its own slug via addApprovedSlugToSourceState
 * (which reads current state, appends, and deduplicates). No deferral is needed:
 * the old "wait for last sibling" guard was a leftover from the snapshot-write model
 * and caused earlier-approved slugs to be silently dropped.
 */
async function persistCandidateSourceStates(
  root: string,
  candidate: ReviewCandidate,
): Promise<void> {
  const states = candidate.sourceStates;
  if (!states) return;
  for (const [sourceFile, candidateEntry] of Object.entries(states)) {
    await addApprovedSlugToSourceState(root, sourceFile, candidate.slug, candidateEntry.hash);
  }
}

/**
 * Merge the approved slug into a source's existing live-concepts list.
 * Reads the current state entry so any already-live concepts are preserved,
 * then appends the approved slug (deduplicating in case it is already present).
 */
async function addApprovedSlugToSourceState(
  root: string,
  sourceFile: string,
  approvedSlug: string,
  sourceHash: string,
): Promise<void> {
  const currentState = await readState(root);
  const existing = currentState.sources[sourceFile];
  const concepts = existing?.concepts ?? [];
  const merged = Array.from(new Set([...concepts, approvedSlug]));
  await updateSourceState(root, sourceFile, {
    hash: sourceHash,
    concepts: merged,
    compiledAt: new Date().toISOString(),
  });
}

/** Refresh interlinks, index, MOC, and embeddings after writing a candidate. */
async function refreshWikiAfterApproval(root: string, slug: string): Promise<void> {
  await resolveLinks(root, [slug], [slug]);
  await generateIndex(root);
  await generateMOC(root);
  await safelyUpdateEmbeddings(root, [slug]);
}

/**
 * Refresh the embeddings store without failing approval.
 * Mirrors the compiler's tolerance: missing API keys / transient provider
 * failures should warn, not abort the approval flow.
 */
async function safelyUpdateEmbeddings(root: string, slugs: string[]): Promise<void> {
  try {
    await updateEmbeddings(root, slugs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.warn(`Skipped embeddings update: ${message}`));
  }
}
