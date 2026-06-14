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
import {
  atomicWrite,
  validateWikiPage,
} from "../utils/markdown.js";
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
 * exit code 1 if the candidate has disappeared or fails page validation.
 */
async function approveUnderLock(root: string, id: string): Promise<void> {
  const candidate = await readCandidateUnderLock(root, id);
  if (!candidate) return;

  if (!validateWikiPage(candidate.body)) {
    output.status("!", output.error(`Candidate ${id} failed page validation; not approved.`));
    process.exitCode = 1;
    return;
  }

  const dir = candidate.targetDirectory === "queries" ? QUERIES_DIR : CONCEPTS_DIR;
  const pagePath = path.join(root, dir, `${candidate.slug}.md`);
  await atomicWrite(pagePath, candidate.body);
  output.status("+", output.success(`Approved → ${output.source(pagePath)}`));

  await persistCandidateSourceStates(root, candidate);
  await refreshWikiAfterApproval(root, candidate.slug);
  await deleteCandidate(root, id);
  output.status("✓", output.dim(`Candidate ${id} cleared.`));
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
