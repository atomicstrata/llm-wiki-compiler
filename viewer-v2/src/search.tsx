/**
 * Server full-text search for the command palette: debounced live results for
 * a query, with a response that arrives after the query has moved on dropped
 * so the palette never shows stale hits, plus the small formatting helpers the
 * palette and the search results screen share.
 */
import { useEffect, useState } from "react";
import { fetchSearch, type SearchResult } from "./api";

const DEBOUNCE_MS = 200;

/** The kind chip of a hit: its entity type, or query, timeline or concept. */
export function resultKind(result: SearchResult): string {
  return result.entityType || (DIRECTORY_KINDS[result.pageDirectory] ?? "concept");
}

/** The kind chip of a default page by its directory; anything else reads as a concept. */
const DIRECTORY_KINDS: Partial<Record<string, string>> = { queries: "query", timeline: "timeline" };

/** Leftover wikilink syntax in a snippet reads as its label. */
export function plainSnippet(snippet: string): string {
  return snippet.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
}

const NO_RESULTS: SearchResult[] = [];

/**
 * Debounced live results for `query`; none for a blank query. While a new
 * query is pending the previous results stay, so the list does not flash
 * empty between keystrokes; a failed search shows none.
 */
export function useLiveResults(query: string): SearchResult[] {
  const trimmed = query.trim();
  const [results, setResults] = useState(NO_RESULTS);
  useEffect(() => {
    if (trimmed.length === 0) return undefined;
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      fetchSearch(trimmed).then(
        (response) => { if (isCurrent) setResults(response.results); },
        () => { if (isCurrent) setResults(NO_RESULTS); },
      );
    }, DEBOUNCE_MS);
    return () => { isCurrent = false; window.clearTimeout(timer); };
  }, [trimmed]);
  return trimmed.length === 0 ? NO_RESULTS : results;
}
