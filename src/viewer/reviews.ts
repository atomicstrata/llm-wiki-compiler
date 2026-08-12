/**
 * Read-only `/api/reviews` projection for the viewer.
 *
 * Review candidates live under `.llmwiki/candidates/` — NOT in the frozen
 * `ViewerSnapshot` — so this surface is fed at REQUEST time by
 * `listCandidatePage(root, REVIEW_LIST_LIMIT)`, the bounded sibling of the
 * read-only, sanitizing loader `review list` and `review show` use. It is
 * strictly read-only: the viewer has no write path, so there is deliberately no
 * approve/reject counterpart here.
 *
 * The response is BOUNDED in both directions — rows served and files read (see
 * {@link REVIEW_LIST_LIMIT}) — and carries `total` so the client can say how
 * much of the queue it is showing. Truncating without saying so would make a
 * capped list read as the whole queue.
 *
 * The projection serves ONLY what the `#/reviews` list renders. Two omissions
 * are load-bearing rather than incidental:
 *
 *  - `body` — the ENTIRE generated page, frontmatter included — is dropped. A
 *    list view never renders it, and serving it would balloon the payload with
 *    unbounded, unreviewed LLM-generated text for no benefit.
 *  - No field may carry an absolute path. `/api/reviews` does not participate
 *    in the non-loopback `isLoopback` suppression that `/api/page` and
 *    `/api/index` apply to citation chips, so anything emitted here is
 *    readable by every LAN client under `--allow-lan`. `sources` is therefore
 *    reduced to bare filenames (see {@link toSourceFilenames}); every other
 *    field is an id, a slug, a timestamp, or policy-authored prose.
 */

import path from "path";
import type { CandidatePage } from "../compiler/candidates.js";
import type { ReviewCandidate } from "../utils/types.js";
import type { HeldReason } from "../review/policy.js";

/**
 * How many candidates one `/api/reviews` response serves — and, because
 * `listCandidatePage` reads only what it serves, how many candidate files one
 * request opens.
 *
 * The route re-reads disk per visit and `heldReasons: "all"` is a real policy
 * code meaning "hold every page", so a 5,000-page corpus compiled under it puts
 * 5,000 files behind a single request. 200 is chosen from both ends: it is far
 * beyond what anyone scrolls through in a read-only queue — `llmwiki review
 * list` is the tool for working a long queue, and the pane says so once the cap
 * bites — while fixing the per-request cost at 200 reads and parses however
 * large the corpus grows.
 */
export const REVIEW_LIST_LIMIT = 200;

/** A single stable JSON row in the `/api/reviews` envelope. */
export interface ReviewCandidateRow {
  /** Candidate id, as `llmwiki review show <id>` takes it. */
  id: string;
  /** Proposed page title. */
  title: string;
  /** Filename slug the approved page would be written to. */
  slug: string;
  /** Short summary carried on the candidate; may be empty. */
  summary: string;
  /** Contributing source filenames — bare basenames, never paths. */
  sources: string[];
  /** ISO timestamp the candidate was generated at. */
  generatedAt: string;
  /** Whether the candidate was policy-held, forced, imported, or connector-fetched. */
  reviewMode: string;
  /** Structured reasons the candidate is awaiting review. */
  heldReasons: HeldReason[];
  /** Wiki subdir approval writes into; absent when the candidate does not set one. */
  targetDirectory?: string;
  /**
   * Declared entity type approval routes a TYPED candidate to; absent on a
   * default candidate.
   *
   * Carried because it, not `targetDirectory`, decides where `review approve`
   * writes: `routeApprovedPageWrite` sends a candidate with this field through
   * the typed planner to `wiki/<targetEntityType>/<slug>.md`, and only a
   * candidate WITHOUT it takes the concepts/queries path. A row projecting the
   * directory alone therefore names the wrong destination for exactly the
   * candidates whose destination is not obvious.
   */
  targetEntityType?: string;
}

/**
 * Reduce a candidate's `sources` to bare filenames.
 *
 * Candidates normally record plain source basenames, so for well-formed data
 * this is a no-op. It is applied anyway because `listCandidates` validates
 * `sources` only as "an array" — a hand-edited or legacy candidate file can
 * carry an absolute path, and this route has no suppression layer to catch one
 * downstream. Non-string entries are dropped rather than coerced.
 */
function toSourceFilenames(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  return sources.filter((s): s is string => typeof s === "string").map((s) => path.basename(s));
}

/** Map one candidate to its stable JSON row, dropping everything else. */
function toReviewRow(candidate: ReviewCandidate): ReviewCandidateRow {
  const row: ReviewCandidateRow = {
    id: candidate.id,
    title: candidate.title,
    slug: candidate.slug,
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    sources: toSourceFilenames(candidate.sources),
    generatedAt: candidate.generatedAt,
    reviewMode: candidate.reviewMode,
    heldReasons: candidate.heldReasons,
  };
  if (candidate.targetDirectory !== undefined) row.targetDirectory = candidate.targetDirectory;
  if (candidate.targetEntityType !== undefined) row.targetEntityType = candidate.targetEntityType;
  return row;
}

/** The `/api/reviews` response body. */
export interface ReviewsEnvelope {
  /** The candidates served — at most {@link REVIEW_LIST_LIMIT} of them. */
  reviews: ReviewCandidateRow[];
  /**
   * How many candidates are pending in total. Equals `reviews.length` until the
   * cap bites; above it, the difference is what the client reports as
   * "showing N of M" rather than passing a truncated list off as the queue.
   */
  total: number;
}

/**
 * Project a bounded page of pending candidates into the `/api/reviews`
 * envelope. Pure (no I/O) so the route handler stays a thin read-and-serialize,
 * mirroring {@link file://./workflow-runs.ts}.
 *
 * @param page - A bounded slice plus true total, from `listCandidatePage(root, REVIEW_LIST_LIMIT)`.
 * @returns The envelope body, one row per served candidate (order preserved).
 */
export function buildReviewsEnvelope(page: CandidatePage): ReviewsEnvelope {
  return { reviews: page.candidates.map(toReviewRow), total: page.total };
}
