/**
 * The page list: a filter box over every page title, capped so a wiki with
 * thousands of pages still renders instantly.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { PageRow } from "./api";
import { pageHref } from "./route";

/** Most rows rendered at once; the filter narrows the rest into view. */
const MAX_VISIBLE_PAGES = 200;

interface SidebarProps {
  pages: PageRow[];
  activePageId: string | null;
}

/** Pages whose title contains every word of the filter, case-insensitively. */
function filterPages(pages: PageRow[], filter: string): PageRow[] {
  const words = filter.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return pages;
  return pages.filter((page) => {
    const title = page.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

/** The filterable list of pages. */
export function Sidebar({ pages, activePageId }: SidebarProps): ReactNode {
  const [filter, setFilter] = useState("");
  const matches = useMemo(() => filterPages(pages, filter), [pages, filter]);
  const visible = matches.slice(0, MAX_VISIBLE_PAGES);
  return (
    <nav className="sidebar" aria-label="Pages">
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter pages"
        aria-label="Filter pages by title"
      />
      <p className="sidebar-count">
        {visible.length === matches.length ? `${matches.length} pages` : `Showing ${visible.length} of ${matches.length}`}
      </p>
      <ul>
        {visible.map((page) => (
          <li key={page.id}>
            <a href={pageHref(page.pageDirectory, page.slug)} aria-current={page.id === activePageId ? "page" : undefined}>
              {page.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
