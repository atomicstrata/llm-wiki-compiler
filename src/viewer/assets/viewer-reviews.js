/**
 * llmwiki viewer — the #/reviews list route.
 *
 * A peer of #/concepts, #/queries, and #/sources: same `.list-row` language,
 * same empty-state contract. It lives in its own module rather than in
 * viewer-lists.js because that module's routes all render from the already
 * fetched /api/pages envelope and issue no request of their own — review
 * candidates are not in the frozen snapshot, so this route is fed by a
 * per-visit /api/reviews fetch.
 *
 * Rows are informational only. The viewer is a read-only snapshot with no
 * write path, so there is no approve/reject affordance here — the row states
 * what is held and why, and the CLI acts on it.
 */

import { el, emptyState, heading } from "./viewer-dom.js";
import { plural, relativeAge } from "./viewer-format.js";

/**
 * Human wording for each policy held-reason code (see `src/review/policy.ts`
 * for the closed set). A reader of the review queue needs to know what to do
 * about a hold; `provenance-violating` does not say that and "Citation problem"
 * does. Unknown codes fall through to the raw code so a reason added later is
 * visible-but-ugly rather than silently invisible.
 */
const HELD_REASON_LABELS = {
  "low-confidence": "Low confidence",
  contradicted: "Contradicts its sources",
  "schema-violating": "Breaks a schema rule",
  "provenance-violating": "Citation problem",
  all: "Policy holds every page",
  "manual-review-requested": "Review requested",
  "imported-okf": "Imported from an OKF bundle",
  "connector-fetched": "Fetched by a connector",
};

/** Wiki subdirectory a candidate lands in when it does not name one. */
const DEFAULT_TARGET_DIRECTORY = "concepts";

/**
 * The command that shows a queue too long for this route. The viewer is
 * read-only and unpaginated, so when the endpoint's cap bites the CLI is where
 * the rest of the queue lives.
 */
const FULL_QUEUE_COMMAND = "llmwiki review list";

/**
 * Render the review-queue route from an `/api/reviews` payload.
 *
 * @param {HTMLElement} main - The main pane to render into.
 * @param {{reviews?: unknown[], total?: number}} payload - The `/api/reviews`
 *   envelope. `total` is the whole queue's depth, which can exceed the rows
 *   served (the endpoint is bounded — see `src/viewer/reviews.ts`).
 */
export function renderReviewsList(main, payload) {
  const reviews = reviewsIn(payload);
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Reviews"));
  appendTruncationNotice(main, reviews.length, totalIn(payload, reviews.length));
  const body = el("div", "list-body");
  main.appendChild(body);
  if (reviews.length === 0) {
    body.appendChild(emptyReviewsState());
    return;
  }
  for (const review of reviews) body.appendChild(buildReviewRow(review));
}

/** The rows in an `/api/reviews` envelope, defended against a malformed payload. */
function reviewsIn(payload) {
  return Array.isArray(payload?.reviews) ? payload.reviews : [];
}

/**
 * The queue's true depth, falling back to the rows on screen when the payload
 * does not carry one — an absent `total` must never be read as "zero pending",
 * which would turn a full queue into a phantom truncation notice.
 */
function totalIn(payload, shownCount) {
  const total = payload?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : shownCount;
}

/**
 * State the slice when the endpoint served fewer candidates than exist. A list
 * that quietly stops at the cap reads as "you have 200 pending reviews", so the
 * pane names both numbers — the same honesty the Lint panel's `other · N rules`
 * roll-up follows. Nothing is drawn when the whole queue is on screen: a
 * caption restating a count the reader can see is noise.
 */
function appendTruncationNotice(main, shownCount, total) {
  if (total <= shownCount) return;
  const shown = `Showing ${shownCount} of ${plural(total, "pending candidate")}`;
  const notice = `${shown} · ${FULL_QUEUE_COMMAND} shows the whole queue`;
  main.appendChild(el("p", "list-caption", notice));
}

/**
 * Empty state for a queue with nothing pending. An empty review queue is the
 * common case AND a good one, so it gets the design system's teaching card
 * rather than the italic placeholder — that helper is for transient loading
 * text, and this state is neither transient nor a failure.
 */
function emptyReviewsState() {
  return emptyState(
    "Nothing awaiting review",
    "Review candidates are pages the compiler held back instead of writing live. Approve one with the CLI and it becomes a wiki page.",
    "$ llmwiki compile --review",
  );
}

/**
 * Build one candidate row: a head line (title plus how long it has waited),
 * the summary, where it came from and where approval would put it, then the
 * reasons it is held.
 */
function buildReviewRow(review) {
  const row = el("div", "list-row review-row");
  row.appendChild(buildReviewHead(review));
  row.appendChild(el("p", "review-summary", reviewSummaryText(review)));
  row.appendChild(el("p", "review-sources", reviewSourcesText(review)));
  row.appendChild(buildReviewReasons(review.heldReasons));
  return row;
}

/**
 * Head line: the title and its age. The title is plain text, NOT a link —
 * a candidate proposes a page that does not exist in `wiki/` yet, so there is
 * nothing to navigate to and a link would 404.
 */
function buildReviewHead(review) {
  const head = el("div", "review-head");
  head.appendChild(el("span", "list-title", review.title || review.slug));
  head.appendChild(el("span", "list-age", relativeAge(review.generatedAt)));
  return head;
}

/** Summary text, falling back to a plain statement rather than an empty line. */
function reviewSummaryText(review) {
  const summary = typeof review.summary === "string" ? review.summary.trim() : "";
  return summary.length > 0 ? summary : "No summary recorded.";
}

/**
 * Provenance line: the source filenames behind the candidate and the wiki
 * subdirectory approval writes into, so the reader can see both what it was
 * built from and where it would land.
 */
// Optional chaining on `sources` plus the empty-sources fallback inflates
// cyclomatic count for what is a two-part string projection (cognitive
// complexity: 2).
// fallow-ignore-next-line complexity
function reviewSourcesText(review) {
  const sources = Array.isArray(review.sources) ? review.sources : [];
  const from = sources.length > 0 ? sources.join(" · ") : "No sources recorded";
  return `${from} → wiki/${targetDirectoryOf(review)}/`;
}

/**
 * Where approving this candidate actually writes.
 *
 * `review approve` routes on `targetEntityType` FIRST: a typed candidate goes
 * through the profile-validated planner to `wiki/<entityType>/`, and only a
 * candidate without one falls to the concepts/queries path. Reading the
 * directory first — or defaulting a typed candidate to `concepts` — would state
 * a destination approval never uses, on the one screen whose job is to tell a
 * reviewer what they are about to accept.
 */
function targetDirectoryOf(review) {
  if (typeof review.targetEntityType === "string" && review.targetEntityType.length > 0) {
    return review.targetEntityType;
  }
  return review.targetDirectory || DEFAULT_TARGET_DIRECTORY;
}

/** Build the chip row naming every reason the candidate is held. */
function buildReviewReasons(heldReasons) {
  const wrap = el("div", "review-reasons");
  const reasons = Array.isArray(heldReasons) ? heldReasons : [];
  for (const reason of reasons) wrap.appendChild(buildReviewReason(reason));
  return wrap;
}

/**
 * One reason chip. The chip reads as human wording; the structured `detail`
 * (e.g. "confidence 0.4 < 0.6") goes on the title attribute, where it explains
 * the hold on hover without turning every chip into a sentence.
 */
// Optional chaining on the reason's two fields inflates cyclomatic count for
// what is a lookup plus an optional attribute (cognitive complexity: 2).
// fallow-ignore-next-line complexity
function buildReviewReason(reason) {
  const code = typeof reason?.code === "string" ? reason.code : "";
  const chip = el("span", "review-reason", HELD_REASON_LABELS[code] ?? code);
  if (typeof reason?.detail === "string" && reason.detail.length > 0) chip.title = reason.detail;
  return chip;
}
