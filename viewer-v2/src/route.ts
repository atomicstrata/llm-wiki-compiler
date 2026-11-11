/**
 * Hash routes for the v2 viewer.
 *
 * The server renders wikilinks as `#/<directory>/<slug>` and source links as
 * `#/_source/<file>`, the same forms the original client uses, so both clients
 * follow the same links. A source route may carry a cited line range as
 * `?start=12&end=15`. The screens of the original client keep their hashes
 * too: `#/index`, `#/recent`, `#/concepts`, `#/queries`, `#/sources`,
 * `#/graph`, `#/health`, `#/reviews`, `#/source-changes`, `#/workflows` and
 * `#/pipeline`. `#/timeline` lists the generated day and week pages, which open
 * as ordinary pages at `#/timeline/<day-or-week>`. A profile's typed list lives at `#/_type/<entity-type>`, so a
 * type sharing a name with one of those screens still opens its own pages.
 * `#/_search?q=`, the pages carrying a tag at `#/_tag/<tag>`, and a run's
 * journey at `#/_journey/<workflow>/<run>` are the routes only this client
 * has. Reserved segments start with an underscore, which no page directory
 * can.
 */

/** The three lists of a default project. */
export type ListKind = "concepts" | "queries" | "sources";

/** A parsed location inside the viewer. */
export type Route =
  | { view: "home" }
  | { view: "index" }
  | { view: "recent" }
  | { view: "timeline" }
  | { view: "list"; kind: ListKind }
  | { view: "typeList"; type: string }
  | { view: "graph" }
  | { view: "health" }
  | { view: "reviews" }
  | { view: "sourceChanges" }
  | { view: "workflows" }
  | { view: "pipeline" }
  | { view: "journey"; workflowId: string; runId: string }
  | { view: "page"; directory: string; slug: string }
  | { view: "source"; id: string; lineStart?: number; lineEnd?: number }
  | { view: "search"; query: string }
  | { view: "tag"; tag: string };

const HOME: Route = { view: "home" };
const SOURCE_SEGMENT = "_source";
const TYPE_SEGMENT = "_type";
const SEARCH_SEGMENT = "_search";
const JOURNEY_SEGMENT = "_journey";
const TAG_SEGMENT = "_tag";
const WHOLE_NUMBER = /^\d+$/;

/** Single-segment hashes that name a screen outright. */
const STATIC_ROUTES: ReadonlyMap<string, Route> = new Map<string, Route>([
  ["index", { view: "index" }],
  ["recent", { view: "recent" }],
  ["timeline", { view: "timeline" }],
  ["concepts", { view: "list", kind: "concepts" }],
  ["queries", { view: "list", kind: "queries" }],
  ["sources", { view: "list", kind: "sources" }],
  ["graph", { view: "graph" }],
  ["health", { view: "health" }],
  ["reviews", { view: "reviews" }],
  ["source-changes", { view: "sourceChanges" }],
  ["workflows", { view: "workflows" }],
  ["pipeline", { view: "pipeline" }],
]);

/** Parse `location.hash` into a route; anything malformed is the home route. */
export function parseRoute(hash: string): Route {
  const [rawPath, rawQuery = ""] = hash.replace(/^#/, "").split("?");
  const segments = decodeSegments(rawPath);
  if (segments === null || segments.length === 0) return HOME;
  const params = new URLSearchParams(rawQuery);
  if (segments[0] === SEARCH_SEGMENT) return { view: "search", query: params.get("q") ?? "" };
  if (segments.length === 1) return STATIC_ROUTES.get(segments[0]) ?? HOME;
  if (segments[0] === JOURNEY_SEGMENT) {
    return segments.length === 3 ? { view: "journey", workflowId: segments[1], runId: segments[2] } : HOME;
  }
  if (segments.length !== 2) return HOME;
  if (segments[0] === TYPE_SEGMENT) return { view: "typeList", type: segments[1] };
  if (segments[0] === TAG_SEGMENT) return { view: "tag", tag: segments[1] };
  if (segments[0] === SOURCE_SEGMENT) {
    return { view: "source", id: segments[1], ...lineRange(params.get("start"), params.get("end")) };
  }
  return { view: "page", directory: segments[0], slug: segments[1] };
}

/** Hash for the pages carrying `tag`. */
export function tagHref(tag: string): string {
  return `#/${TAG_SEGMENT}/${encodeURIComponent(tag)}`;
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

/** Hash for a profile entity type's list. */
export function typeListHref(type: string): string {
  return `#/${TYPE_SEGMENT}/${encodeURIComponent(type)}`;
}

/** Hash for a source, optionally pointing at a cited line range. */
export function sourceHref(id: string, lineStart?: number, lineEnd?: number): string {
  const base = `#/${SOURCE_SEGMENT}/${encodeURIComponent(id)}`;
  if (lineStart === undefined) return base;
  return `${base}?start=${lineStart}&end=${lineEnd ?? lineStart}`;
}

/** Hash for a search. */
export function searchHref(query: string): string {
  return `#/${SEARCH_SEGMENT}?q=${encodeURIComponent(query)}`;
}

/** Hash for one workflow run's journey. */
export function journeyHref(workflowId: string, runId: string): string {
  return `#/${JOURNEY_SEGMENT}/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}`;
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
export function lineRange(start: string | null | undefined, end: string | null | undefined): { lineStart?: number; lineEnd?: number } {
  const lineStart = lineNumber(start);
  if (lineStart === undefined) return {};
  const lineEnd = lineNumber(end) ?? lineStart;
  return lineEnd >= lineStart ? { lineStart, lineEnd } : {};
}
