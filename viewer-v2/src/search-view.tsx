/**
 * Full-text search results for a query, each linking to its page with its
 * kind and, for a body match, the passage that matched. The palette's last
 * row opens this screen for a query.
 */
import type { ReactNode } from "react";
import { fetchSearch } from "./api";
import { AsyncView } from "./async-view";
import { Badge, Card, ROW_LINK, RowList, Screen } from "./components";
import { pageIdHref } from "./route";
import { plainSnippet, resultKind } from "./search";
import { useAsync } from "./use-async";
import { plural, typeLabel } from "./wiki-model";

/** Load and list the pages matching `query`. */
export function SearchView({ query }: { query: string }): ReactNode {
  const state = useAsync(() => fetchSearch(query), query);
  return (
    <AsyncView state={state}>
      {({ results }) => (
        <Screen title={`Search: ${query}`} description={`${plural(results.length, "page")} ${results.length === 1 ? "matches" : "match"}`}>
          <Card flush>
            {results.length === 0 && <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">No pages match.</p>}
            <RowList>
              {results.map((result) => (
                <li key={result.id}>
                  <a href={pageIdHref(result.id)} data-row="" data-page-id={result.id}
                    className={`block ${ROW_LINK}`}>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">{result.title || result.id}</span>
                      <Badge>{typeLabel(resultKind(result))}</Badge>
                    </span>
                    {result.matchedIn === "body" && <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500 dark:text-zinc-400">{plainSnippet(result.snippet)}</span>}
                  </a>
                </li>
              ))}
            </RowList>
          </Card>
        </Screen>
      )}
    </AsyncView>
  );
}
