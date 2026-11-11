/**
 * The list screens: concepts with a freshness filter, saved queries, a
 * profile type's pages, and the source files. Every list reads the already
 * loaded envelope and adds a title filter, so a wiki with thousands of pages
 * narrows instantly without another request.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { Badge, Card, EmptyState, Row, RowList, Screen, SelectField, TextField } from "./components";
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

/** One page row: title, freshness when it needs attention, citation count, age, and anything the screen adds. */
export function PageRowItem({ page, now, trailing }: { page: PageRow; now: Date; trailing?: ReactNode }): ReactNode {
  const status = page.freshness.freshnessStatus;
  const warnCitations = page.unresolvedCitationCount > 0;
  return (
    <Row href={pageHref(page.pageDirectory, page.slug)} title={page.title || page.slug}
      trailing={
        <>
          {trailing}
          {isWarnFreshness(status) && <Badge tone="amber">{status}</Badge>}
          <span title={warnCitations ? `${page.unresolvedCitationCount} unresolved` : "citations"}>
            <Badge tone={warnCitations ? "amber" : "neutral"}>{page.citationCount}</Badge>
          </span>
        </>
      }
      meta={relativeAge(page.updatedAt, now)} />
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
    <Screen title={heading} description={plural(pages.length, "page")}>
      {pages.length === 0 ? whenEmpty : (
        <Card flush>
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-950/5 p-3 dark:border-white/10">
            <TextField value={title} onChange={setTitle} placeholder="Filter by title" label="Filter by title" />
            {freshnessFilter && (
              <SelectField value={freshness} onChange={(value) => setFreshness(value as FreshnessFilter)} label="Freshness">
                {FRESHNESS_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </SelectField>
            )}
            <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{shown.length === pages.length ? plural(pages.length, "page") : `${shown.length} of ${pages.length}`}</span>
          </div>
          {shown.length === 0 && <p className="p-4 text-sm text-zinc-500">No pages match this filter.</p>}
          <RowList>{shown.map((page) => <PageRowItem key={page.id} page={page} now={now} />)}</RowList>
        </Card>
      )}
    </Screen>
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

/** The pages carrying one tag, from any directory. */
export function TagList({ wiki, tag }: { wiki: PagesEnvelope; tag: string }): ReactNode {
  return (
    <PageList heading={`#${tag}`} pages={wiki.pages.filter((page) => page.tags.includes(tag))}
      whenEmpty={<EmptyState title="No pages carry this tag" body="Tags come from each page's frontmatter. The compiler writes them; this tag may have been removed by a later compile." />} />
  );
}

/** The source files on disk; each opens its numbered text. */
export function SourcesList({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [filter, setFilter] = useState("");
  const names = wiki.sourceFilenames.filter((name) => name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Screen title={isProfileProject(wiki) ? "Raw sources" : "Sources"} description={`${wiki.counts.compiledSources} compiled · ${wiki.counts.sourceFiles} on disk`}>
      {wiki.sourceFilenames.length === 0 ? (
        <EmptyState title="No sources yet" body="Sources are the raw files the compiler reads. Every claim on a page traces back to a span in one of them." command="$ llmwiki ingest <source>" />
      ) : (
        <Card flush>
          <div className="border-b border-zinc-950/5 p-3 dark:border-white/10">
            <TextField value={filter} onChange={setFilter} placeholder="Filter by file name" label="Filter by file name" />
          </div>
          <RowList>{names.map((name) => <Row key={name} href={sourceHref(name)} title={<span className="font-mono text-xs">{name}</span>} />)}</RowList>
        </Card>
      )}
    </Screen>
  );
}
