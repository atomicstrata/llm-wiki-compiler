/** Search results for a query, each linking to its page. */
import type { ReactNode } from "react";
import { fetchSearch } from "./api";
import { AsyncView } from "./async-view";
import { Card, RowList, Screen } from "./components";
import { pageIdHref } from "./route";
import { useAsync } from "./use-async";

/** Load and list the pages matching `query`. */
export function SearchView({ query }: { query: string }): ReactNode {
  const state = useAsync(() => fetchSearch(query), query);
  return (
    <AsyncView state={state}>
      {({ results }) => (
        <Screen title={`Search: ${query}`}>
          <Card flush>
            {results.length === 0 && <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">No pages match.</p>}
            <RowList>
              {results.map((result) => (
                <li key={result.id} className="px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-white/5">
                  <a href={pageIdHref(result.id)} className="block truncate font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">{result.title}</a>
                  <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{result.snippet}</p>
                </li>
              ))}
            </RowList>
          </Card>
        </Screen>
      )}
    </AsyncView>
  );
}
