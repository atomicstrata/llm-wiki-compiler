/**
 * Hash routes for the v2 viewer.
 *
 * The server renders wikilinks as `#/<directory>/<slug>` and source links as
 * `#/_source/<file>`, the same forms the original client uses, so both clients
 * follow the same links. A source route may carry a cited line range as
 * `?start=12&end=15`. `#/_search?q=` is the one route only this client has.
 * Both reserved segments start with an underscore, which no page directory can.
 */

/** A parsed location inside the viewer. */
export type Route =
  | { view: "home" }
  | { view: "page"; directory: string; slug: string }
  | { view: "source"; id: string; lineStart?: number; lineEnd?: number }
  | { view: "search"; query: string };

const HOME: Route = { view: "home" };
const SOURCE_SEGMENT = "_source";
const WHOLE_NUMBER = /^\d+$/;
const SEARCH_SEGMENT = "_search";

/** Parse `location.hash` into a route; anything malformed is the home route. */
export function parseRoute(hash: string): Route {
  const [rawPath, rawQuery = ""] = hash.replace(/^#/, "").split("?");
  const segments = decodeSegments(rawPath);
  if (segments === null || segments.length === 0) return HOME;
  const params = new URLSearchParams(rawQuery);
  if (segments[0] === SEARCH_SEGMENT) return { view: "search", query: params.get("q") ?? "" };
  if (segments.length !== 2) return HOME;
  if (segments[0] === SOURCE_SEGMENT) {
    return { view: "source", id: segments[1], ...lineRange(params.get("start"), params.get("end")) };
  }
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
  const base = `#/${SOURCE_SEGMENT}/${encodeURIComponent(id)}`;
  if (lineStart === undefined) return base;
  return `${base}?start=${lineStart}&end=${lineEnd ?? lineStart}`;
}

/** Hash for a citation chip's `data-file` / `data-line-start` / `data-line-end`; null without a file. */
export function citationHref(file: string | undefined, lineStart?: string, lineEnd?: string): string | null {
  if (!file) return null;
  const range = lineRange(lineStart, lineEnd);
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

/** A whole number from a query value or data attribute; undefined for anything else. */
function lineNumber(value: string | null | undefined): number | undefined {
  return WHOLE_NUMBER.test(value ?? "") ? Number(value) : undefined;
}

/** A cited line range; the end defaults to the start, and a reversed range is no range. */
function lineRange(start: string | null | undefined, end: string | null | undefined): { lineStart?: number; lineEnd?: number } {
  const lineStart = lineNumber(start);
  if (lineStart === undefined) return {};
  const lineEnd = lineNumber(end) ?? lineStart;
  return lineEnd >= lineStart ? { lineStart, lineEnd } : {};
}
