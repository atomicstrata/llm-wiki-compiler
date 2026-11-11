/**
 * Every page newest first, grouped by when it was last compiled: today,
 * yesterday, earlier this week, last week, earlier this month, then by month.
 * A page whose created and updated times match was created in that compile,
 * and says so with a visible "new" word rather than colour alone.
 */
import { useMemo, type ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { groupByRecency } from "./recency";
import { PageRowItem } from "./lists";
import { plural } from "./wiki-model";

/** Whether the page's last write created it. */
export function isNewPage(page: PageRow): boolean {
  return page.createdAt.length > 0 && page.createdAt === page.updatedAt;
}

/** The grouped recency screen. */
export function RecentView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const now = useMemo(() => new Date(), [wiki]);
  const groups = useMemo(() => groupByRecency(wiki.pages, (page) => page.updatedAt, now), [wiki, now]);
  return (
    <section className="list-screen">
      <h1>Recent</h1>
      <p className="list-caption">{plural(wiki.pages.length, "page")}, newest first</p>
      {groups.length === 0 && <p className="status">Nothing compiled yet.</p>}
      {groups.map((group) => (
        <div key={group.label} className="recency-group">
          <h2>{group.label} <span className="list-count">{group.items.length}</span></h2>
          <ul className="page-list">
            {group.items.map((page) => (
              <PageRowItem key={page.id} page={page} now={now} trailing={isNewPage(page) ? <span className="badge-new">new</span> : null} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
