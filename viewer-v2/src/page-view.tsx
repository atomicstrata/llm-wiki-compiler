/**
 * One wiki page: the heading rules of the original client, its rendered body,
 * the images its cited sources keep, and the support rail beside it. The
 * graph loads alongside the page so the rail can list backlinks, which the
 * page payload does not carry.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fetchGraph, fetchPage, type GraphData, type PagePayload, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { Badge, Notice } from "./components";
import { Outline, assignHeadingIds, type OutlineItem } from "./outline";
import { rememberPage } from "./palette-model";
import { safeLocalStorage } from "./storage";
import { pageTitle, stripLeadingHeading } from "./page-model";
import { tagHref } from "./route";
import { useMediaQuery } from "./media";
import { NeighbourhoodSection } from "./page-neighbourhood";
import { PageRail } from "./page-rail";
import { RailSheet } from "./rail-sheet";
import { SourceImages } from "./source-images-view";
import { useAsync, type AsyncState } from "./use-async";
import { WikiHtml } from "./wiki-html";

/** Keep only the non-blank string entries of a frontmatter value that should be a list, as `/api/pages` does for tags. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** A locale date for an ISO timestamp, or an empty string when there is none. */
function formatDate(timestamp: string): string {
  return timestamp ? new Date(timestamp).toLocaleDateString() : "";
}

/** Heading, the question line of a saved query, and one banner per warning. */
export function PageHeader({ page }: { page: PagePayload }): ReactNode {
  const title = pageTitle(page);
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight text-balance text-zinc-950 dark:text-white">{title}</h1>
      {page.pageDirectory === "queries" && <p className="mt-2 text-zinc-500 italic dark:text-zinc-400">Question: {title}</p>}
      {page.warnings.length > 0 && (
        <div className="mt-4 space-y-2">
          {page.warnings.map((warning, index) => <Notice key={index} alert code={warning.code}>{warning.message || warning.code}</Notice>)}
        </div>
      )}
    </>
  );
}

/** Tags and last-updated date on one line; nothing when the page has neither. */
function PageMeta({ page }: { page: PagePayload }): ReactNode {
  const updated = formatDate(page.updatedAt);
  const tags = stringList(page.frontmatter.tags);
  if (tags.length === 0 && !updated) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
      {tags.map((tag) => <a key={tag} href={tagHref(tag)} className="rounded-md hover:ring-2 hover:ring-indigo-600/20"><Badge>{tag}</Badge></a>)}
      {updated && <span className="ml-1">Updated {updated}</span>}
    </p>
  );
}

/** The rendered body minus a heading that repeats the title, or a note when the page has no body. */
export function PageBody({ page, onRender }: { page: PagePayload; onRender?: (container: HTMLElement) => void }): ReactNode {
  if (page.html.length === 0) return <p className="text-sm text-zinc-500">No rendered content.</p>;
  return <WikiHtml html={stripLeadingHeading(page.html, pageTitle(page))} onRender={onRender} />;
}

/** From this width the rail sits beside the article; below it, it opens as a bottom sheet. Tailwind's `lg`. */
const WIDE_LAYOUT = "(min-width: 64rem)";

interface PageViewProps {
  directory: string;
  slug: string;
  wiki: PagesEnvelope;
}

/** The rail's sections: the outline, the neighbourhood graph, then metadata, citations and connections. */
function Rail({ page, wiki, graph, outline }: { page: PagePayload; wiki: PagesEnvelope; graph: AsyncState<GraphData>; outline: OutlineItem[] }): ReactNode {
  return (
    <>
      <Outline items={outline} />
      <NeighbourhoodSection pageId={page.id} wiki={wiki} graph={graph} />
      <PageRail page={page} wiki={wiki} graph={graph} />
    </>
  );
}

/** Load and show the page at `directory/slug` with its support rail. */
export function PageView({ directory, slug, wiki }: PageViewProps): ReactNode {
  const state = useAsync(() => fetchPage(directory, slug), `${directory}/${slug}`);
  // Keyed on the snapshot, so backlinks and the neighbourhood follow a compile like the rest of the screen.
  const graph = useAsync(fetchGraph, wiki.updatedAt);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // Only a page that loaded is worth a recent slot; a broken link is not.
  useEffect(() => {
    if (state.status === "ready") rememberPage(`${directory}/${slug}`, safeLocalStorage());
  }, [state.status, directory, slug]);
  const onRender = (container: HTMLElement): void => setOutline(assignHeadingIds(container));
  const wide = useMediaQuery(WIDE_LAYOUT);
  return (
    <AsyncView state={state}>
      {(page) => (
        <div className="mx-auto flex max-w-6xl flex-col gap-10 lg:flex-row lg:items-start lg:justify-center">
          <article className="max-w-[68ch] min-w-0 flex-1">
            <header className="mb-8 border-b border-zinc-950/5 pb-6 dark:border-white/10">
              <PageHeader page={page} />
              <PageMeta page={page} />
            </header>
            <PageBody page={page} onRender={onRender} />
            <SourceImages sourceIds={stringList(page.frontmatter.sources)} />
          </article>
          {wide
            ? <aside aria-label="Page details" className="sticky top-20 max-h-[calc(100dvh-6rem)] w-72 shrink-0 space-y-4 overflow-y-auto"><Rail page={page} wiki={wiki} graph={graph} outline={outline} /></aside>
            : <RailSheet><Rail page={page} wiki={wiki} graph={graph} outline={outline} /></RailSheet>}
        </div>
      )}
    </AsyncView>
  );
}
