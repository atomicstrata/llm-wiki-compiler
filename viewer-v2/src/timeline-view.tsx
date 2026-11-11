/**
 * The timeline: what happened when, by the sources' own dates. Each ISO week
 * shows its summary page, when compiled, above its day pages, newest first.
 * The pages themselves open as ordinary wiki pages with their citations.
 *
 * A wiki compiled without the timeline has no such pages, and the screen says
 * how to turn it on. {@link TimelineNav} sits on each timeline page and steps
 * through time: the previous and next day or week, a day's week, a week's days.
 */
import type { ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { Card, EmptyState, Row, RowList, Screen, TextLink } from "./components";
import { pageHref } from "./route";
import { timelineLinks, timelineWeeks, type TimelineWeek } from "./timeline-model";
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

/** A link to a timeline page, with `children` as its text and an optional `rel` (`prev`, `next`). */
function PageLink({ page, rel, children }: { page: PageRow; rel?: string; children: ReactNode }): ReactNode {
  return <TextLink href={pageHref(page.pageDirectory, page.slug)} rel={rel}>{children}</TextLink>;
}

/** A day's title without its year, `Thursday, November 5`, for the step links. */
function shortTitle(page: PageRow): string {
  return (page.title || page.slug).replace(/, \d{4}$/, "");
}

/** Steps through time from a timeline page: previous and next, up to the week, and a week's days. */
export function TimelineNav({ slug, wiki }: { slug: string; wiki: PagesEnvelope }): ReactNode {
  const links = timelineLinks(wiki.pages, slug);
  return (
    <nav aria-label="Timeline" className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="min-w-0">{links.previous && <PageLink page={links.previous} rel="prev"><span aria-hidden="true">← </span>{shortTitle(links.previous)}</PageLink>}</span>
        {links.week ? <PageLink page={links.week}>{links.week.title}</PageLink> : <TextLink href="#/timeline">Timeline</TextLink>}
        <span className="min-w-0 text-right">{links.next && <PageLink page={links.next} rel="next">{shortTitle(links.next)}<span aria-hidden="true"> →</span></PageLink>}</span>
      </div>
      {links.days.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <span id="timeline-days" className="text-zinc-500 dark:text-zinc-400">Days</span>
          <ul aria-labelledby="timeline-days" className="flex flex-wrap gap-x-3 gap-y-1">
            {links.days.map((day) => <li key={day.id}><PageLink page={day}>{shortTitle(day).split(",")[0]}</PageLink></li>)}
          </ul>
        </div>
      )}
    </nav>
  );
}
