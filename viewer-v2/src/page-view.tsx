/**
 * One wiki page: its rendered body and the images its cited sources keep.
 * The compiler already writes each page's source list into the body.
 */
import type { ReactNode } from "react";
import { fetchPage, type PagePayload } from "./api";
import { AsyncView } from "./async-view";
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

/** Tags and last-updated date; renders empty (and hidden) when the page has neither. */
function PageMeta({ page }: { page: PagePayload }): ReactNode {
  const updated = formatDate(page.updatedAt);
  return (
    <p className="page-meta">
      {stringList(page.frontmatter.tags).map((tag) => <span key={tag} className="tag">{tag}</span>)}
      {updated && <span>Updated {updated}</span>}
    </p>
  );
}

/** Load and show the page at `directory/slug`. */
export function PageView({ directory, slug }: { directory: string; slug: string }): ReactNode {
  const state = useAsync(() => fetchPage(directory, slug), `${directory}/${slug}`);
  return (
    <AsyncView state={state}>
      {(page) => {
        const sourceIds = stringList(page.frontmatter.sources);
        return (
          <article>
            <PageMeta page={page} />
            <WikiHtml html={page.html} />
            <SourceImages sourceIds={sourceIds} />
          </article>
        );
      }}
    </AsyncView>
  );
}
