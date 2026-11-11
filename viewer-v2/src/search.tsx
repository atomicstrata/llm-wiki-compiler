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
    <form className="relative ml-auto w-full min-w-0 max-w-sm" role="search" onSubmit={onSubmit} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <input ref={input} type="search" value={query} placeholder="Search…" aria-label="Search wiki"
        className="block w-full rounded-md bg-zinc-950/5 py-1.5 pr-10 pl-3 text-sm text-zinc-900 placeholder:text-zinc-500 focus:bg-white focus:ring-2 focus:ring-indigo-600 focus:outline-none dark:bg-white/5 dark:text-white dark:focus:bg-zinc-900 dark:focus:ring-indigo-500"
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onInputKey} />
      <kbd aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 my-auto hidden h-5 rounded sm:block border border-zinc-950/10 px-1 font-sans text-xs text-zinc-400 dark:border-white/10">⌘K</kbd>
      {showList && (
        <ul ref={list} className="absolute inset-x-0 top-full z-40 mt-2 max-h-[70vh] overflow-y-auto rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-950/10 sm:-right-24 dark:bg-zinc-900 dark:ring-white/10" role="listbox" aria-label="Search results" onKeyDown={(event) => onResultKey(event, input.current)}>
          {error !== null && <li className="px-3 py-2 text-sm text-red-600 dark:text-red-400">Search failed: {error}</li>}
          {error === null && results.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No matches.</li>}
          {results.map((result) => (
            <li key={result.id} role="option">
              <a href={pageIdHref(result.id)} onClick={() => { setQuery(""); setOpen(false); }}
                className="block rounded-lg px-3 py-2 hover:bg-zinc-950/5 focus:bg-zinc-950/5 focus:outline-none dark:hover:bg-white/5 dark:focus:bg-white/5">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{resultKind(result)}</span>{" "}
                <span className="block truncate text-sm font-medium text-zinc-900 dark:text-white">{result.title || result.id}</span>{" "}
                {result.matchedIn === "body" && <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500 dark:text-zinc-400">{plainSnippet(result.snippet)}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
