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
import {
  deleteCandidate,
  listCandidates,
} from "../compiler/candidates.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveLinks } from "../compiler/resolver.js";
import { updateEmbeddingsDispatched as updateEmbeddings } from "../utils/embeddings-dispatch.js";
import { updateSourceState } from "../utils/state.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
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

  const pagePath = path.join(root, CONCEPTS_DIR, `${candidate.slug}.md`);
  await atomicWrite(pagePath, candidate.body);
  output.status("+", output.success(`Approved → ${output.source(pagePath)}`));

  await persistCandidateSourceStates(root, candidate);
  await refreshWikiAfterApproval(root, candidate.slug);
  await deleteCandidate(root, id);
  output.status("✓", output.dim(`Candidate ${id} cleared.`));
}

/**
 * Flush the source-state snapshot stored on the candidate into
 * `.llmwiki/state.json` so the contributing source files are marked
 * compiled. Without this, approved candidates would re-appear on the next
 * `compile` run because the source still looks "new" or "changed" to the
 * change detector.
 *
 * When a single source produced multiple candidates (e.g. an extraction
 * yielded several concepts), persisting state on the first approval would
 * mark the source as fully compiled and silently strand the remaining
 * pending candidates — the next `compile --review` would skip the source
 * entirely. To avoid that, we only persist a source's state when no OTHER
 * pending candidate still references that source filename.
 */
async function persistCandidateSourceStates(
  root: string,
  candidate: ReviewCandidate,
): Promise<void> {
  const states = candidate.sourceStates;
  if (!states) return;
  const otherSources = await collectOtherCandidateSources(root, candidate.id);
  for (const [sourceFile, entry] of Object.entries(states)) {
    if (otherSources.has(sourceFile)) continue;
    await updateSourceState(root, sourceFile, entry);
  }
}

/**
 * Build the set of source filenames referenced by every pending candidate
 * other than the one currently being approved. Used to defer source-state
 * persistence until the LAST candidate from a given source is reviewed.
 */
async function collectOtherCandidateSources(
  root: string,
  approvingId: string,
): Promise<Set<string>> {
  const pending = await listCandidates(root);
  const sources = new Set<string>();
  for (const candidate of pending) {
    if (candidate.id === approvingId) continue;
    for (const source of candidate.sources) sources.add(source);
  }
  return sources;
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
