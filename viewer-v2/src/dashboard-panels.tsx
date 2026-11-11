/**
 * The dashboard's live panels: what changed since the reader's last visit, a
 * calendar of compile activity, and a topic map of the wiki's tags. Each is
 * derived from the page list the shell already holds, which refreshes while
 * the tab is visible, so they move when a compile lands.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { PageRow } from "./api";
import { changedSince, dailyActivity, heatLevel, stampVisit, tagCounts, tagWeight, ACTIVITY_WEEKS } from "./activity-model";
import { Card, RowList, TextLink } from "./components";
import { PageRowItem } from "./lists";
import { tagHref } from "./route";
import { safeLocalStorage } from "./storage";
import { plural } from "./wiki-model";

/** How many changed pages the panel lists before pointing at the recently updated list. */
const CHANGED_ROWS = 6;
const TOPIC_LIMIT = 32;

/** What counts as new on this visit, read once when the dashboard mounts. */
export function usePreviousVisit(): string | null {
  return useState(() => stampVisit(safeLocalStorage(), new Date()))[0];
}

/** Pages changed since the last visit; null when there is no last visit or nothing changed. */
export function SinceLastVisit({ pages, since }: { pages: PageRow[]; since: string | null }): ReactNode {
  const changed = useMemo(() => (since === null ? [] : changedSince(pages, since)), [pages, since]);
  const now = new Date();
  if (since === null || changed.length === 0) return null;
  const when = new Date(since).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return (
    <Card flush title={`${plural(changed.length, "page")} changed since your last visit on ${when}`}
      action={<TextLink href="#/recent">See all recently updated</TextLink>}>
      <RowList>
        {changed.slice(0, CHANGED_ROWS).map((page) => (
          <PageRowItem key={page.id} page={page} now={now} />
        ))}
      </RowList>
    </Card>
  );
}

const HEAT_CLASS = [
  "bg-zinc-100 dark:bg-white/5",
  "bg-indigo-200 dark:bg-indigo-900",
  "bg-indigo-400 dark:bg-indigo-700",
  "bg-indigo-500 dark:bg-indigo-500",
  "bg-indigo-700 dark:bg-indigo-300",
] as const;

/** A calendar of pages updated per day, weeks as columns, Sunday on top. */
export function ActivityCard({ pages }: { pages: PageRow[] }): ReactNode {
  const days = useMemo(() => dailyActivity(pages, new Date()), [pages]);
  const max = Math.max(0, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return (
    <Card title="Activity" action={<span className="text-xs text-zinc-500 dark:text-zinc-400">{plural(total, "page")} updated in {ACTIVITY_WEEKS} weeks</span>}
      footer={<span className="flex items-center gap-1">Less {HEAT_CLASS.map((shade) => <span key={shade} className={`size-2.5 rounded-sm ${shade}`} />)} More</span>}>
      <div role="img" aria-label={`${plural(total, "page")} updated in the last ${ACTIVITY_WEEKS} weeks; the busiest day had ${max}.`}
        className="grid grid-flow-col grid-rows-7 justify-start gap-1 overflow-x-auto">
        {days.map((day) => (
          <span key={day.date} title={`${day.date}: ${plural(day.count, "page")}`} className={`size-3 rounded-sm ${HEAT_CLASS[heatLevel(day.count, max)]}`} />
        ))}
      </div>
    </Card>
  );
}

const TOPIC_SIZE = ["text-xs", "text-sm", "text-base", "text-lg font-medium"] as const;

/** The most used tags, sized by how many pages carry them; each opens its pages. */
export function TopicsCard({ pages }: { pages: PageRow[] }): ReactNode {
  const topics = useMemo(() => tagCounts(pages, TOPIC_LIMIT), [pages]);
  const max = topics[0]?.count ?? 0;
  return (
    <Card title="Topics" action={<span className="text-xs text-zinc-500 dark:text-zinc-400">by tag</span>}>
      {topics.length === 0 ? <p className="text-sm text-zinc-500">No page carries a tag yet.</p> : (
        <ul role="list" className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          {topics.map(({ tag, count }) => (
            <li key={tag}>
              <a href={tagHref(tag)} title={plural(count, "page")}
                className={`text-zinc-700 hover:text-indigo-600 dark:text-zinc-300 dark:hover:text-indigo-400 ${TOPIC_SIZE[tagWeight(count, max)]}`}>
                {tag}<sup className="ml-0.5 text-[10px] text-zinc-400 tabular-nums">{count}</sup>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
