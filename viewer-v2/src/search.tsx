/**
 * Server full-text search for the command palette: debounced live results for
 * a query, with a response that arrives after the query has moved on dropped
 * so the palette never shows stale hits, plus the small formatting helpers the
 * palette and the search results screen share.
 */
import { useEffect, useState } from "react";
import { fetchSearch, type SearchResult } from "./api";

const DEBOUNCE_MS = 200;

/** The kind chip of a hit: its entity type, or query, or concept. */
export function resultKind(result: SearchResult): string {
  if (result.entityType) return result.entityType;
  return result.pageDirectory === "queries" ? "query" : "concept";
}

/** Leftover wikilink syntax in a snippet reads as its label. */
export function plainSnippet(snippet: string): string {
  return snippet.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/** Debounced live results for `query`; empty for a blank query. */
export function useLiveResults(query: string): { results: SearchResult[]; error: string | null } {
  const [state, setState] = useState<{ results: SearchResult[]; error: string | null }>({ results: [], error: null });
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setState({ results: [], error: null });
      return undefined;
    }
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      fetchSearch(trimmed).then(
        ({ results }) => { if (isCurrent) setState({ results, error: null }); },
        (error: unknown) => { if (isCurrent) setState({ results: [], error: error instanceof Error ? error.message : String(error) }); },
      );
    }, DEBOUNCE_MS);
    return () => { isCurrent = false; window.clearTimeout(timer); };
  }, [query]);
  return state;
}
