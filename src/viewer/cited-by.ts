/**
 * Reverse citations: which wiki pages cite one source file, and which of its
 * lines. The snapshot already holds every page's parsed citations, so this is
 * a filter over memory, not a read of the source or of any page file; it
 * reveals only page titles and line numbers, never source text, which is why
 * `GET /api/source/<id>/cited-by` needs no loopback guard while `/content`
 * keeps one.
 */
import type { ViewerPage } from "./types.js";

/** One cited line range; null when the citation names the whole file. */
export type CitedLines = { start: number; end: number } | null;

/** One page that cites the source, with every span it cites; its id is also its route (`<directory>/<slug>`). */
export interface CitingPage {
  id: string;
  title: string;
  spans: CitedLines[];
}

/** The `/cited-by` payload. */
export interface CitedByPayload {
  source: string;
  pages: CitingPage[];
}

/** The spans of `page` that cite `file`, in the order they appear, without repeats. */
function spansCiting(page: ViewerPage, file: string): CitedLines[] {
  const seen = new Set<string>();
  const spans: CitedLines[] = [];
  for (const span of page.citations.flatMap((citation) => citation.spans)) {
    if (span.file !== file) continue;
    const lines = span.lines ? { start: span.lines.start, end: span.lines.end } : null;
    const key = lines ? `${lines.start}-${lines.end}` : "file";
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(lines);
  }
  return spans;
}

/** Every page citing `file`, sorted by title. */
export function citedBy(pages: readonly ViewerPage[], file: string): CitedByPayload {
  const citing = pages.flatMap((page): CitingPage[] => {
    const spans = spansCiting(page, file);
    if (spans.length === 0) return [];
    return [{ id: page.id, title: page.title || page.slug, spans }];
  });
  return { source: file, pages: citing.sort((a, b) => a.title.localeCompare(b.title)) };
}
