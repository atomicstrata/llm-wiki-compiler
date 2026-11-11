/**
 * Every knowledge page newest first, grouped by when it was last compiled: today,
 * yesterday, earlier this week, last week, earlier this month, then by month.
 * A page whose created and updated times match was created in that compile,
 * and says so with a visible "new" word rather than colour alone. The generated
 * day and week pages have their own screen, the timeline, so they are left out.
 */
import type { ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { Badge, Card, EmptyState, RowList, Screen } from "./components";
import { PageRowItem } from "./lists";
import { groupByRecency } from "./recency";
import { withoutTimeline } from "./timeline-model";
import { plural } from "./wiki-model";

/** Whether the page's last write created it. */
export function isNewPage(page: PageRow): boolean {
  return page.createdAt.length > 0 && page.createdAt === page.updatedAt;
}

/** The grouped recency screen. */
export function RecentView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const now = new Date();
  const pages = withoutTimeline(wiki.pages);
  const groups = groupByRecency(pages, (page) => page.updatedAt, now);
  return (
    <Screen title="Recently updated" description={`${plural(pages.length, "page")}, newest first`}>
      {groups.length === 0 ? <EmptyState title="Nothing compiled yet" body="Compiled pages appear here, newest first." command="$ llmwiki compile" /> : (
      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.label}>
            <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {group.label} <span className="text-xs font-normal text-zinc-400 tabular-nums">{group.items.length}</span>
            </h2>
            <Card flush>
              <RowList>
                {group.items.map((page) => (
                  <PageRowItem key={page.id} page={page} now={now} trailing={isNewPage(page) ? <Badge tone="indigo">new</Badge> : null} />
                ))}
              </RowList>
            </Card>
          </section>
        ))}
      </div>
      )}
    </Screen>
  );
}
