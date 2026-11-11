/**
 * The header search box: debounced live results in a dropdown, ⌘K or Ctrl+K
 * to focus from anywhere, arrow keys to move through results, Enter on the
 * box to open the full results route. A response that arrives after the
 * query has moved on is dropped so the list never shows stale hits.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { fetchSearch, type SearchResult } from "./api";
import { pageIdHref, searchHref } from "./route";


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

/** Whether the keydown is the global search shortcut and not typed into another field. */
function isSearchShortcut(event: globalThis.KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && target.matches("input, textarea, [contenteditable]"));
}

/** Debounced live results for `query`; empty for a blank query. */
function useLiveResults(query: string): { results: SearchResult[]; error: string | null } {
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

/** Move focus among the results list with the arrow keys; Escape returns to the box. */
function onResultKey(event: KeyboardEvent<HTMLUListElement>, input: HTMLInputElement | null): void {
  const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a"));
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (event.key === "Escape") { input?.focus(); return; }
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (step === 0 || links.length === 0) return;
  event.preventDefault();
  links[(index + step + links.length) % links.length].focus();
}

/** The search box with its dropdown. */
export function SearchBox({ initialQuery }: { initialQuery: string }): ReactNode {
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { results, error } = useLiveResults(open ? query : "");
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (isSearchShortcut(event)) { event.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (query.trim().length > 0) { setOpen(false); window.location.hash = searchHref(query.trim()); }
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector("a")?.focus(); }
    if (event.key === "Escape") setOpen(false);
  };
  const showList = open && query.trim().length > 0;
  return (
    <form className="relative" role="search" onSubmit={onSubmit} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <input ref={input} type="search" value={query} placeholder="Search…" aria-label="Search wiki"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onInputKey} />
      <span aria-hidden="true">⌘K</span>{" "}
      {showList && (
        <ul ref={list} className="absolute z-10 border bg-white p-2 dark:bg-black" role="listbox" aria-label="Search results" onKeyDown={(event) => onResultKey(event, input.current)}>
          {error !== null && <li>Search failed: {error}</li>}
          {error === null && results.length === 0 && <li>No matches.</li>}
          {results.map((result) => (
            <li key={result.id} role="option">
              <a href={pageIdHref(result.id)} onClick={() => { setQuery(""); setOpen(false); }}>
                <span>{resultKind(result)}</span>{" "}
                <span>{result.title || result.id}</span>{" "}
                {result.matchedIn === "body" && <span>{plainSnippet(result.snippet)}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
