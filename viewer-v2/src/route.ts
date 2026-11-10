/**
 * Hash routes for the v2 viewer.
 *
 * The server renders wikilinks as `#/<directory>/<slug>`, so the client keeps
 * that shape for pages and adds two reserved first segments: `sources` for an
 * ingested source (optionally with a cited line range) and `search`.
 */

/** A parsed location inside the viewer. */
export type Route =
  | { view: "home" }
  | { view: "page"; directory: string; slug: string }
  | { view: "source"; id: string; lineStart?: number; lineEnd?: number }
  | { view: "search"; query: string };

const HOME: Route = { view: "home" };
const SOURCES_SEGMENT = "sources";
const SEARCH_SEGMENT = "search";

/** Parse `location.hash` into a route; anything malformed is the home route. */
export function parseRoute(hash: string): Route {
  const [rawPath, rawQuery = ""] = hash.replace(/^#/, "").split("?");
  const segments = decodeSegments(rawPath);
  if (segments === null || segments.length === 0) return HOME;
  const params = new URLSearchParams(rawQuery);
  if (segments[0] === SEARCH_SEGMENT) return { view: "search", query: params.get("q") ?? "" };
  if (segments.length !== 2) return HOME;
  if (segments[0] === SOURCES_SEGMENT) return { view: "source", id: segments[1], ...parseLines(params.get("lines")) };
  return { view: "page", directory: segments[0], slug: segments[1] };
}

/** Hash for a wiki page, matching the links the server renders. */
export function pageHref(directory: string, slug: string): string {
  return `#/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`;
}

/** Hash for a page given its `directory/slug` id. */
export function pageIdHref(id: string): string {
  const [directory, slug = ""] = id.split("/");
  return pageHref(directory, slug);
}

/** Hash for a source, optionally pointing at a cited line range. */
export function sourceHref(id: string, lineStart?: number, lineEnd?: number): string {
  const base = `#/${SOURCES_SEGMENT}/${encodeURIComponent(id)}`;
  if (lineStart === undefined) return base;
  return `${base}?lines=${lineStart}-${lineEnd ?? lineStart}`;
}

/** Hash for a citation chip's `data-file` / `data-line-start` / `data-line-end`; null without a file. */
export function citationHref(file: string | undefined, lineStart?: string, lineEnd?: string): string | null {
  if (!file) return null;
  const range = parseLines(lineStart === undefined ? null : `${lineStart}-${lineEnd ?? lineStart}`);
  return sourceHref(file, range.lineStart, range.lineEnd);
}

/** Hash for a search. */
export function searchHref(query: string): string {
  return `#/${SEARCH_SEGMENT}?q=${encodeURIComponent(query)}`;
}

/** Decode each path segment; null when any segment is not valid percent-encoding. */
function decodeSegments(rawPath: string): string[] | null {
  try {
    return rawPath.split("/").filter((segment) => segment.length > 0).map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** Parse `12` or `12-15` into a line range; anything else is no range. */
function parseLines(value: string | null): { lineStart?: number; lineEnd?: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value ?? "");
  if (!match) return {};
  const lineStart = Number(match[1]);
  const lineEnd = Number(match[2] ?? match[1]);
  return lineEnd >= lineStart ? { lineStart, lineEnd } : {};
}
