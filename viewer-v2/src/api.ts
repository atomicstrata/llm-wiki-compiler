/**
 * Typed client for the viewer's read-only JSON API.
 *
 * Every function maps to one route of the local viewer server. The shapes
 * list only the fields this client reads; the server sends more.
 */

/** One row of the page list. */
export interface PageRow {
  id: string;
  pageDirectory: string;
  slug: string;
  title: string;
  summary: string;
  updatedAt: string;
}

/** The bootstrap envelope: project identity, counts, and every page. */
export interface PagesEnvelope {
  project: { title: string };
  counts: { concepts: number; queries: number; sourceFiles: number; pendingReviews: number };
  index: { available: boolean };
  pages: PageRow[];
}

/** One rendered page. `html` is sanitized by the server. */
export interface PagePayload {
  id: string;
  title: string;
  html: string;
  updatedAt: string;
  frontmatter: { tags?: unknown; sources?: unknown };
}

/** One search hit. */
export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
}

/** Metadata of an ingested source. */
export interface SourceMeta {
  id: string;
  title?: string;
  health: string;
  locator?: string;
}

/** Read a JSON route, failing on any non-2xx status. */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`);
  return (await response.json()) as T;
}

/** The page list and project summary. */
export function fetchPages(): Promise<PagesEnvelope> {
  return getJson("/api/pages");
}

/** One page by directory and slug. */
export function fetchPage(directory: string, slug: string): Promise<PagePayload> {
  return getJson(`/api/page/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`);
}

/** The rendered `wiki/index.md`. */
export function fetchIndex(): Promise<{ html: string }> {
  return getJson("/api/index");
}

/** Pages matching a query. */
export function fetchSearch(query: string): Promise<{ results: SearchResult[] }> {
  return getJson(`/api/search?q=${encodeURIComponent(query)}`);
}

/** Metadata of one source. */
export function fetchSourceMeta(id: string): Promise<SourceMeta> {
  return getJson(`/api/source/${encodeURIComponent(id)}`);
}

/** Full text of one source, with its physical line numbers intact. */
export async function fetchSourceText(id: string): Promise<string> {
  const path = `/api/source/${encodeURIComponent(id)}/content`;
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`);
  return response.text();
}

/** URL of an image kept in `sources/images/`. */
export function sourceImageUrl(file: string): string {
  return `/api/source-image/${encodeURIComponent(file)}`;
}
