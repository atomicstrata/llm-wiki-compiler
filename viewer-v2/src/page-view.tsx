/**
 * One wiki page: the heading rules of the original client, its rendered body,
 * the images its cited sources keep, and the support rail beside it. The
 * graph loads alongside the page so the rail can list backlinks, which the
 * page payload does not carry.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fetchGraph, fetchPage, type PagePayload, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { Badge } from "./components";
import { Outline, assignHeadingIds, type OutlineItem } from "./outline";
import { rememberPage } from "./palette-model";
import { pageTitle, stripLeadingHeading } from "./page-model";
import { PageRail } from "./page-rail";
import { SourceImages } from "./source-images-view";
import { useAsync } from "./use-async";
import { WikiHtml } from "./wiki-html";

/** Keep only the string entries of a frontmatter value that should be a list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
      {page.warnings.map((warning, index) => (
        <div key={index} role="alert" data-code={warning.code}
          className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-600/20 ring-inset dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
          {warning.message || warning.code}
        </div>
      ))}
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
      {tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}{" "}
      {updated && <span className="ml-1">Updated {updated}</span>}
    </p>
  );
}

/** The rendered body minus a heading that repeats the title, or a note when the page has no body. */
export function PageBody({ page, onRender }: { page: PagePayload; onRender?: (container: HTMLElement) => void }): ReactNode {
  if (page.html.length === 0) return <p className="text-sm text-zinc-500">No rendered content.</p>;
  return <WikiHtml html={stripLeadingHeading(page.html, pageTitle(page))} onRender={onRender} />;
}

interface PageViewProps {
  directory: string;
  slug: string;
  wiki: PagesEnvelope;
}

/** Load and show the page at `directory/slug` with its support rail. */
export function PageView({ directory, slug, wiki }: PageViewProps): ReactNode {
  const state = useAsync(() => fetchPage(directory, slug), `${directory}/${slug}`);
  const graph = useAsync(fetchGraph, "graph");
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  useEffect(() => rememberPage(`${directory}/${slug}`), [directory, slug]);
  const onRender = (container: HTMLElement): void => setOutline(assignHeadingIds(container));
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
          <div className="space-y-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:w-72 lg:shrink-0 lg:overflow-y-auto">
            <Outline items={outline} />
            <PageRail page={page} wiki={wiki} graph={graph} />
          </div>
        </div>
      )}
    </AsyncView>
  );
}
