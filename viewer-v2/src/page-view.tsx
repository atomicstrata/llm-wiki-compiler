/**
 * One wiki page: the heading rules of the original client, its rendered body,
 * the images its cited sources keep, and the support rail beside it. The
 * graph loads alongside the page so the rail can list backlinks, which the
 * page payload does not carry.
 */
import type { ReactNode } from "react";
import { fetchGraph, fetchPage, type PagePayload, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
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
      <h1>{title}</h1>
      {page.pageDirectory === "queries" && <p>Question: {title}</p>}
      {page.warnings.map((warning, index) => (
        <div key={index} role="alert" data-code={warning.code}>{warning.message || warning.code}</div>
      ))}
    </>
  );
}

/** Tags and last-updated date on one line; nothing when the page has neither. */
function PageMeta({ page }: { page: PagePayload }): ReactNode {
  const updated = formatDate(page.updatedAt);
  const parts = [...stringList(page.frontmatter.tags), ...(updated ? [`Updated ${updated}`] : [])];
  return parts.length > 0 ? <p>{parts.join(" · ")}</p> : null;
}

/** The rendered body minus a heading that repeats the title, or a note when the page has no body. */
export function PageBody({ page }: { page: PagePayload }): ReactNode {
  if (page.html.length === 0) return <p>No rendered content.</p>;
  return <WikiHtml html={stripLeadingHeading(page.html, pageTitle(page))} />;
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
  return (
    <AsyncView state={state}>
      {(page) => (
        <div>
          <article>
            <PageHeader page={page} />
            <PageMeta page={page} />
            <PageBody page={page} />
            <SourceImages sourceIds={stringList(page.frontmatter.sources)} />
          </article>
          <PageRail page={page} wiki={wiki} graph={graph} />
        </div>
      )}
    </AsyncView>
  );
}
