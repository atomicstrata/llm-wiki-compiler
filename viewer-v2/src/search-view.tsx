/** Search results for a query, each linking to its page. */
import type { ReactNode } from "react";
import { fetchSearch } from "./api";
import { AsyncView } from "./async-view";
import { pageIdHref } from "./route";
import { useAsync } from "./use-async";

/** Load and list the pages matching `query`. */
export function SearchView({ query }: { query: string }): ReactNode {
  const state = useAsync(() => fetchSearch(query), query);
  return (
    <AsyncView state={state}>
      {({ results }) => (
        <section>
          <h1>Search: {query}</h1>
          {results.length === 0 && <p>No pages match.</p>}
          <ul>
            {results.map((result) => (
              <li key={result.id}>
                <a href={pageIdHref(result.id)}>{result.title}</a>
                <p>{result.snippet}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AsyncView>
  );
}
