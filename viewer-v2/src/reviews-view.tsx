/**
 * The review queue: the candidates the compiler held back instead of writing
 * live, each with its age, summary, provenance, destination and the reasons
 * it is held. Candidates are not in the frozen snapshot, so the screen fetches
 * `/api/reviews` on every visit. Rows are informational only: the viewer has
 * no write path, so the CLI approves or rejects.
 */
import type { ReactNode } from "react";
import { fetchReviews, type HeldReason, type ReviewCandidate, type ReviewsEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { Badge, Card, Code, EmptyState, RowList, Screen, TextLink } from "./components";
import { relativeAge } from "./recency";
import { useAsync } from "./use-async";
import { plural } from "./wiki-model";

/** Human wording for each held-reason code; an unknown code shows raw rather than vanishing. */
const HELD_REASON_LABELS: Record<string, string> = {
  "low-confidence": "Low confidence",
  contradicted: "Contradicts its sources",
  "schema-violating": "Missing or invalid information",
  "provenance-violating": "Citation problem",
  all: "All pages require review",
  "manual-review-requested": "Review requested",
  "imported-okf": "Imported from a wiki bundle",
  "connector-fetched": "Imported from an external service",
};

/** Wiki subdirectory a candidate lands in when it does not name one. */
const DEFAULT_TARGET_DIRECTORY = "concepts";

/** The command that shows a queue longer than the endpoint serves. */
const FULL_QUEUE_COMMAND = "llmwiki review list";

/**
 * Where approval writes. A typed candidate goes to `wiki/<entityType>/`
 * first; only one without a type falls to the concepts or queries path.
 */
export function targetDirectoryOf(review: ReviewCandidate): string {
  if (review.targetEntityType) return review.targetEntityType;
  return review.targetDirectory || DEFAULT_TARGET_DIRECTORY;
}

/** The chip reads as human wording; the structured detail explains the hold on hover. */
function ReasonChip({ reason }: { reason: HeldReason }): ReactNode {
  return <Badge tone="amber" title={reason.detail || undefined}>{HELD_REASON_LABELS[reason.code] ?? reason.code}</Badge>;
}

/** The title is plain text, not a link: the page does not exist in `wiki/` yet. */
function ReviewRow({ review, now }: { review: ReviewCandidate; now: Date }): ReactNode {
  const summary = review.summary.trim();
  const from = review.sources.length > 0 ? review.sources.join(" · ") : "No sources recorded";
  return (
    <li className="space-y-1.5 px-4 py-3 text-sm">
      <div className="flex items-baseline gap-3">
        <strong className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">{review.title || review.slug}</strong>
        <span className="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{relativeAge(review.generatedAt, now)}</span>
      </div>
      <p className="text-zinc-600 dark:text-zinc-300">{summary.length > 0 ? summary : "No summary recorded."}</p>
      <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">{from} → wiki/{targetDirectoryOf(review)}/</p>
      <div className="flex flex-wrap gap-1.5">{review.heldReasons.map((reason, index) => <ReasonChip key={index} reason={reason} />)}</div>
    </li>
  );
}

/** The queue as served; the caption names both numbers when the endpoint's cap bit. */
export function ReviewsList({ payload }: { payload: ReviewsEnvelope }): ReactNode {
  const now = new Date();
  const shown = payload.reviews.length;
  return (
    <Screen title="Reviews">
      <div className="space-y-4">
        {payload.sourceChanges === true && <p><TextLink href="#/source-changes">Compare changed sources and proposed wiki updates</TextLink></p>}
        {payload.total > shown && <p className="text-sm text-zinc-500 dark:text-zinc-400">Showing {shown} of {plural(payload.total, "pending candidate")} · <Code>{FULL_QUEUE_COMMAND}</Code> shows the whole queue</p>}
        {shown === 0 ? (
          <EmptyState title="Nothing awaiting review" command="$ llmwiki compile --review"
            body="Review candidates are pages the compiler held back instead of writing live. Approve one with the CLI and it becomes a wiki page." />
        ) : (
          <Card flush>
            <RowList>{payload.reviews.map((review) => <ReviewRow key={review.id} review={review} now={now} />)}</RowList>
          </Card>
        )}
      </div>
    </Screen>
  );
}

/** The reviews screen, fetched per visit. */
export function ReviewsView(): ReactNode {
  const state = useAsync(fetchReviews, "reviews");
  return <AsyncView state={state}>{(payload) => <ReviewsList payload={payload} />}</AsyncView>;
}
