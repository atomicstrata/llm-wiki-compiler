/**
 * The timeline: what happened when, by the sources' own dates. Each ISO week
 * shows its summary page, when compiled, above its day pages, newest first.
 * The pages themselves open as ordinary wiki pages with their citations.
 *
 * A wiki compiled without the timeline has no such pages, and the screen says
 * how to turn it on.
 */
import type { ReactNode } from "react";
import type { PagesEnvelope } from "./api";
import { Card, EmptyState, Row, RowList, Screen, TextLink } from "./components";
import { pageHref } from "./route";
import { timelineWeeks, type TimelineWeek } from "./timeline-model";
import { plural } from "./wiki-model";

/** One week: its summary as the card header, its days as rows. */
function WeekCard({ week }: { week: TimelineWeek }): ReactNode {
  const heading = week.page
    ? <TextLink href={pageHref(week.page.pageDirectory, week.page.slug)}>{week.page.title || week.week}</TextLink>
    : week.week;
  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h2>
      {week.page?.summary && <p className="mt-1 mb-3 text-sm text-zinc-500 dark:text-zinc-400">{week.page.summary}</p>}
      <Card flush>
        <RowList>
          {week.days.map((day) => (
            <Row key={day.id} href={pageHref(day.pageDirectory, day.slug)} title={day.title || day.slug} description={day.summary.trim()} />
          ))}
        </RowList>
      </Card>
    </section>
  );
}

/** The timeline screen. */
export function TimelineView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const weeks = timelineWeeks(wiki.pages);
  const dayCount = weeks.reduce((sum, week) => sum + week.days.length, 0);
  return (
    <Screen title="Timeline" description={weeks.length === 0 ? "What happened when" : `${plural(dayCount, "day")} across ${plural(weeks.length, "week")}, newest first`}>
      {weeks.length === 0 ? (
        <EmptyState title="No timeline yet"
          body={'Add "timeline": { "enabled": true } to .llmwiki/schema.json and compile. Each day your sources cover gets a page, and each week a summary.'}
          command="$ llmwiki compile" />
      ) : (
        <div className="space-y-8">{weeks.map((week) => <WeekCard key={week.week} week={week} />)}</div>
      )}
    </Screen>
  );
}
