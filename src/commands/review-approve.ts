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
 *
 * ATOMICITY (scope — do not over-promise). Only the PAGE BYTE-WRITE is journalled
 * and atomic (via the planner/executor batch). The post-write tail —
 * source-state persist, index/MOC/embeddings refresh, and `deleteCandidate` —
 * runs under the SAME lock but is NOT part of the journal batch: it is
 * best-effort and IDEMPOTENT / re-derivable. A crash anywhere in the tail leaves
 * the page written but the candidate possibly un-cleared; recovery is simply
 * re-running `approve` (idempotent) or a `refresh` (which re-derives the index,
 * MOC, embeddings, and source state). The whole operation is NOT a single atomic
 * transaction; only the page write is.
 */

import path from "path";
import { validateWikiPage } from "../utils/markdown.js";
import { planPageMutation } from "../trust/planner.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import {
  applyTypedCandidate,
  CandidateProfileError,
  CandidatePromotionBlockedError,
} from "../trust/promote.js";
import { EntityFieldContractError } from "../profile/field-contract.js";
import { LifecycleTransitionError } from "../profile/lifecycle.js";
import {
  RelationPreconditionUnmetError,
  RelationPreconditionUnverifiableError,
} from "../relations/enforce-precondition.js";
import {
  ArtifactPreconditionUnmetError,
  ArtifactPreconditionUnverifiableError,
} from "../artifacts/enforce-precondition.js";
import { deleteCandidate } from "../compiler/candidates.js";
import { sha256Text } from "../connectors/hash.js";
import { isConnectorCandidate } from "../connectors/origin.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { resolveAndApplyLinks } from "../compiler/resolver.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { refreshEmbeddingsDrainingPending } from "../utils/embeddings-refresh.js";
import { readState, updateSourceState } from "../utils/state.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";
import type { ReviewCandidate } from "../utils/types.js";
import { runReviewUnderLock, readCandidateUnderLock } from "./review-helpers.js";

/** CLI/API options accepted by `review approve`. */
export interface ReviewApproveOptions {
  /** Required for connector candidates: sha256 printed by `review show`. */
  draftContentHash?: string;
}

/** Approve a pending candidate by promoting its body into wiki/concepts/. */
export default async function reviewApproveCommand(
  id: string,
  options: ReviewApproveOptions = {},
): Promise<void> {
  await runReviewUnderLock(id, (root, lockedId) => approveUnderLock(root, lockedId, options));
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
async function approveUnderLock(
  root: string,
  id: string,
  options: ReviewApproveOptions,
): Promise<void> {
  const candidate = await readCandidateUnderLock(root, id);
  if (!candidate) return;
  if (!connectorPinMatches(candidate, options.draftContentHash)) {
    output.status(
      "!",
      output.error(
        "Candidate not approved: re-review required; body changed since you inspected it " +
          "or --draft-content-hash is missing.",
      ),
    );
    process.exitCode = 1;
    return;
  }

  const pagePath = await routeApprovedPageWrite(root, candidate, id);
  if (!pagePath) return;
  output.status("+", output.success(`Approved → ${output.source(pagePath)}`));

  // The source-state tail records the approved slug into the DEFAULT
  // `state.sources[file].concepts` list — a concepts-only structure with no
  // typed discrimination. A TYPED candidate must skip it (mirroring
  // routeApprovedPageWrite's typed/default branch) so a non-concept slug can
  // never pollute concepts state. Default candidates keep the existing path.
  if (!candidate.targetEntityType) {
    await persistCandidateSourceStates(root, candidate);
  }
  await refreshWikiAfterApproval(root, candidate);
  await deleteCandidate(root, id);
  output.status("✓", output.dim(`Candidate ${id} cleared.`));
}

/**
 * Connector candidates require an external operator pin.
 *
 * The comparison re-hashes the under-lock candidate body and deliberately ignores
 * any stored `connectorProvenance.draftContentHash`, which is self-attested data.
 */
function connectorPinMatches(candidate: ReviewCandidate, supplied: string | undefined): boolean {
  if (!isConnectorCandidate(candidate)) return true;
  if (supplied === undefined) return false;
  return sha256Text(candidate.body) === supplied;
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
 * longer declared, the body violates the declared field contract, the body
 * performs an illegal lifecycle transition, a relation-count or artifact-existence
 * precondition for the entered gated state is unmet or unverifiable, or the re-plan
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
    noteTypedReadIntegration(relPath);
    return path.join(root, relPath);
  } catch (err) {
    if (!isTypedPromotionRefusal(err)) throw err;
    output.status("!", output.error(`Candidate ${id} not approved: ${err.message}`));
    process.exitCode = 1;
    return null;
  }
}

/**
 * Whether `err` is a KNOWN typed-candidate promotion refusal surfaced by
 * {@link applyTypedCandidate} — a missing/undeclared profile
 * ({@link CandidateProfileError}), a blocked re-plan ({@link CandidatePromotionBlockedError}),
 * a field-contract violation ({@link EntityFieldContractError}), an illegal lifecycle
 * transition ({@link LifecycleTransitionError}), or a relation- / artifact-precondition
 * that is unmet or unverifiable. Any such error is reported as a clean "not approved"
 * (exit 1, candidate retained); ANY other error propagates. Returning `err is Error`
 * lets the caller read `err.message` after the guard. Centralized here so the routing
 * predicate reads flat rather than inflating {@link routeTypedPageWrite}.
 */
function isTypedPromotionRefusal(err: unknown): err is Error {
  return (
    err instanceof CandidateProfileError ||
    err instanceof CandidatePromotionBlockedError ||
    err instanceof EntityFieldContractError ||
    err instanceof LifecycleTransitionError ||
    err instanceof RelationPreconditionUnmetError ||
    err instanceof RelationPreconditionUnverifiableError ||
    err instanceof ArtifactPreconditionUnmetError ||
    err instanceof ArtifactPreconditionUnverifiableError
  );
}

/**
 * Emit a one-line, non-error informational NOTE after a typed page is written,
 * summarising the current read-integration state: a typed entity page is now
 * surfaced in `status`, JSON export, the wiki index, the viewer graph, agent
 * context packs (lexical ranking + relation-edge expansion), and semantic search
 * (under its qualified EntityId, on the next compile). The note never touches
 * the exit code — a successful typed approval still exits 0.
 *
 * @param relPath - The project-relative `wiki/<entityType>/<slug>.md` path.
 */
function noteTypedReadIntegration(relPath: string): void {
  output.status(
    "i",
    output.info(
      `Typed page ${relPath} written. Visible in viewer graph, context packs ` +
        `(lexical + relation-edge), and semantic search (on next compile).`,
    ),
  );
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
  const { planned } = await planPageMutation({
    root,
    target: { kind: "raw", directory, slug: candidate.slug },
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
async function refreshWikiAfterApproval(root: string, candidate: ReviewCandidate): Promise<void> {
  const { slug } = candidate;
  // approveUnderLock runs under the held project lock (runReviewUnderLock), so
  // this routes through the lock-free resolution seam.
  await resolveAndApplyLinks(root, [slug], [slug]);
  await generateIndex(root);
  await generateMOC(root);
  await safelyUpdateEmbeddings(root, candidatePageId(candidate));
}

/**
 * The qualified pageId of an approved candidate: a TYPED candidate lands under
 * its `targetEntityType` namespace; a DEFAULT candidate under `queries` (when
 * `targetDirectory` is queries) or `concepts`.
 */
function candidatePageId(candidate: ReviewCandidate): PageId {
  const namespace =
    candidate.targetEntityType ?? (candidate.targetDirectory === "queries" ? "queries" : "concepts");
  return qualifiedPageId(namespace, candidate.slug);
}

/**
 * Refresh the embeddings store without failing approval, DRAINING the durable
 * pending marker in the same pass.
 *
 * Routes through the SHARED {@link refreshEmbeddingsDrainingPending} so approving
 * a candidate also retries any page-ids a prior `compile --review` (or a
 * swallowed/crashed refresh) left pending — a review-only workflow would
 * otherwise accumulate pending ids that are never drained, leaving embeddings
 * stale indefinitely. The shared drain settles the marker per-id and is
 * non-fatal on a missing API key / transient provider error. Approval already
 * holds the review lock (runReviewUnderLock), so the lock-free Core is correct
 * (no nested-lock deadlock).
 */
async function safelyUpdateEmbeddings(root: string, pageId: PageId): Promise<void> {
  await refreshEmbeddingsDrainingPending(root, [pageId]);
}
