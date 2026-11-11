/**
 * The list screens: concepts with a freshness filter, saved queries, a
 * profile type's pages, and the source files. Every list reads the already
 * loaded envelope and adds a title filter, so a wiki with thousands of pages
 * narrows instantly without another request.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { relativeAge } from "./recency";
import { pageHref, sourceHref } from "./route";
import { entityTypes, isProfileProject, isWarnFreshness, pagesIn, plural, typeLabel } from "./wiki-model";

const FRESHNESS_FILTERS = [
  { value: "all", label: "All" },
  { value: "stale", label: "Stale" },
  { value: "orphaned", label: "Orphaned" },
  { value: "contradicted", label: "Contradicted" },
  { value: "archived", label: "Archived" },
] as const;
type FreshnessFilter = (typeof FRESHNESS_FILTERS)[number]["value"];

/** Whether a page passes the freshness filter. */
function passesFreshness(page: PageRow, filter: FreshnessFilter): boolean {
  const { freshness } = page;
  if (filter === "all") return true;
  if (filter === "contradicted") return freshness.contradicted;
  if (filter === "archived") return freshness.archived;
  return freshness.freshnessStatus === filter;
}

/** Pages whose title contains every word of the filter, case-insensitively. */
export function matchesTitle(pages: PageRow[], filter: string): PageRow[] {
  const words = filter.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return pages;
  return pages.filter((page) => words.every((word) => page.title.toLowerCase().includes(word)));
}

/** A short explanation shown when a list is empty. */
export function EmptyState({ title, body, command }: { title: string; body: string; command?: string }): ReactNode {
  return (
    <div>
      <strong>{title}</strong>
      <p>{body}</p>
      {command && <code>{command}</code>}
    </div>
  );
}

/** One page row: freshness dot, title, citation count, age, and anything the screen adds. */
export function PageRowItem({ page, now, trailing }: { page: PageRow; now: Date; trailing?: ReactNode }): ReactNode {
  const status = page.freshness.freshnessStatus;
  const warnCitations = page.unresolvedCitationCount > 0;
  return (
    <li>
      {isWarnFreshness(status) && <span>{status}</span>}{" "}
      <a href={pageHref(page.pageDirectory, page.slug)}>{page.title || page.slug}</a>{" "}
      <span title={warnCitations ? `${page.unresolvedCitationCount} unresolved` : "citations"}>
        {page.citationCount}
      </span>{" "}
      <span>{relativeAge(page.updatedAt, now)}</span>{" "}
      {trailing}
    </li>
  );
}

interface PageListProps {
  heading: string;
  pages: PageRow[];
  whenEmpty: ReactNode;
  freshnessFilter?: boolean;
}

/** A heading, filters, and rows; the empty state only when nothing exists at all. */
function PageList({ heading, pages, whenEmpty, freshnessFilter = false }: PageListProps): ReactNode {
  const [title, setTitle] = useState("");
  const [freshness, setFreshness] = useState<FreshnessFilter>("all");
  const now = useMemo(() => new Date(), [pages]);
  const shown = matchesTitle(pages, title).filter((page) => passesFreshness(page, freshness));
  return (
    <section>
      <h1>{heading}</h1>
      {pages.length === 0 ? whenEmpty : (
        <>
          <div>
            <input type="search" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Filter by title" aria-label="Filter by title" />
            {freshnessFilter && (
              <label>Freshness
                <select value={freshness} onChange={(event) => setFreshness(event.target.value as FreshnessFilter)}>
                  {FRESHNESS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            )}
            <span>{shown.length === pages.length ? plural(pages.length, "page") : `${shown.length} of ${pages.length}`}</span>
          </div>
          {shown.length === 0 && <p>No pages match this filter.</p>}
          <ul>{shown.map((page) => <PageRowItem key={page.id} page={page} now={now} />)}</ul>
        </>
      )}
    </section>
  );
}

export function ConceptsList({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  return (
    <PageList heading="Concepts" pages={pagesIn(wiki, "concepts")} freshnessFilter
      whenEmpty={<EmptyState title="No concepts yet" body="Concepts are compiled pages — knowledge extracted once from your sources and kept with its citations." command="$ llmwiki compile" />} />
  );
}

export function QueriesList({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  return (
    <PageList heading="Saved queries" pages={pagesIn(wiki, "queries")}
      whenEmpty={<EmptyState title="No saved queries yet" body="Queries are compiled pages too — ask once and the answer is kept with its citations." command='$ llmwiki query "<question>"' />} />
  );
}

/** A profile type's pages; an undeclared type reads as empty rather than erroring. */
export function TypeList({ wiki, type }: { wiki: PagesEnvelope; type: string }): ReactNode {
  const declared = entityTypes(wiki).find((row) => row.type === type);
  const where = declared ? `under ${declared.directory}/` : "in this category’s configured folder";
  return (
    <PageList heading={typeLabel(type)} pages={pagesIn(wiki, type)}
      whenEmpty={<EmptyState title={`No ${type} yet`} body={`Add a Markdown record ${where} to include it in this list. This viewer is read-only; create or import records outside the viewer.`} />} />
  );
}

/** The source files on disk; each opens its numbered text. */
export function SourcesList({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [filter, setFilter] = useState("");
  const names = wiki.sourceFilenames.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section>
      <h1>{isProfileProject(wiki) ? "Raw sources" : "Sources"}</h1>
      <p>{wiki.counts.compiledSources} compiled · {wiki.counts.sourceFiles} on disk</p>
      {wiki.sourceFilenames.length === 0 ? (
        <EmptyState title="No sources yet" body="Sources are the raw files the compiler reads. Every claim on a page traces back to a span in one of them." command="$ llmwiki ingest <source>" />
      ) : (
        <>
          <div>
            <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by file name" aria-label="Filter by file name" />
          </div>
          <ul>
            {names.map((name) => <li key={name}><a href={sourceHref(name)}>{name}</a></li>)}
          </ul>
        </>
      )}
    </section>
  );
}
