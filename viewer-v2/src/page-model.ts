/**
 * Facts derived from a page payload and the wiki graph that the page view and
 * its support rail show: the heading rules of the original client, citations
 * grouped by source file, backlinks, and relation groups. Pure functions, so
 * the rules are tested without a fetch or a DOM.
 */
import type { ClaimCitation, EntityRelation, GraphData, PagePayload, SourceSpan } from "./api";

/** The warning code the server attaches to each citation whose file is missing. */
const UNRESOLVED_CITATION_CODE = "unresolved_citation";

const LEADING_H1 = /^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>\s*/i;
const TAG = /<[^>]+>/g;
/** The entities the server's sanitizer writes; any other entity is left as written. */
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };

/** The heading of a page: its title, or its slug when the frontmatter has none. */
export function pageTitle(page: PagePayload): string {
  return page.title || page.slug;
}

/** The display kind: frontmatter `kind`, else the saved-query `type`, else the entity type, else concept. */
export function pageKind(page: PagePayload): string {
  const { kind, type } = page.frontmatter;
  if (typeof kind === "string" && kind.length > 0) return kind;
  if (typeof type === "string" && type.length > 0) return type;
  return page.entityType ?? "concept";
}

/** The text of a sanitized HTML fragment, with the entities the sanitizer writes decoded. */
export function htmlText(html: string): string {
  return html.replace(TAG, "").replace(/&[#\w]+;/g, (entity) => ENTITIES[entity] ?? entity).trim();
}

/** The body without a leading `<h1>` that repeats the heading the view already shows. */
export function stripLeadingHeading(html: string, title: string): string {
  const match = LEADING_H1.exec(html);
  if (match === null || title.trim().length === 0) return html;
  return htmlText(match[1]) === title.trim() ? html.slice(match[0].length) : html;
}

/** How many citations the page makes and how many the server could not resolve; the figures of its list row. */
export function pageCitationCounts(page: PagePayload): { total: number; unresolved: number } {
  return {
    total: page.citations.length,
    unresolved: page.warnings.filter((warning) => warning.code === UNRESOLVED_CITATION_CODE).length,
  };
}

/** A cited range as a chip reads it: `L12–15`, `L12`, or "whole file" when the citation names no lines. */
export function rangeLabel(lines: { start: number; end: number } | null | undefined): string {
  if (!lines) return "whole file";
  return lines.end !== lines.start ? `L${lines.start}–${lines.end}` : `L${lines.start}`;
}

/** `notes.md`, `notes.md:12`, `notes.md:12-15`: the label the server gives a citation chip. */
export function spanLabel(span: SourceSpan): string {
  if (span.lines === undefined) return span.file;
  const { start, end } = span.lines;
  return start === end ? `${span.file}:${start}` : `${span.file}:${start}-${end}`;
}

/** Items in first-seen order of their key, each key's items together. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

/** The spans a page cites in one source file. */
export interface CitationGroup {
  file: string;
  /** Whether the file is one the wiki lists under `sources/`. */
  resolved: boolean;
  spans: SourceSpan[];
}

/** Every cited span grouped by file, in citation order, with a span cited twice listed once. */
export function groupCitationsByFile(citations: ClaimCitation[], sourceFilenames: string[]): CitationGroup[] {
  const known = new Set(sourceFilenames);
  return groupBy(citations.flatMap((citation) => citation.spans), (span) => span.file).map((spans) => ({
    file: spans[0].file,
    resolved: known.has(spans[0].file),
    spans: uniqueSpans(spans),
  }));
}

/** The spans with the same label as an earlier one dropped. */
function uniqueSpans(spans: SourceSpan[]): SourceSpan[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    const label = spanLabel(span);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

/** A page that links to the current one. */
export interface Backlink {
  id: string;
  title: string;
}

/** Pages the graph shows linking to `pageId`, by title; a page linking twice is listed once. */
export function backlinksFrom(graph: GraphData, pageId: string): Backlink[] {
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const sources = new Set(graph.edges.filter((edge) => edge.target === pageId && edge.source !== pageId).map((edge) => edge.source));
  return [...sources]
    .map((id) => ({ id, title: titles.get(id) || id }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The relations of one type in one direction. */
export interface RelationGroup {
  type: string;
  direction: EntityRelation["direction"];
  relations: EntityRelation[];
}

/** Relations grouped by type and direction, in the server's order. */
export function groupRelations(relations: EntityRelation[]): RelationGroup[] {
  return groupBy(relations, (relation) => `${relation.type}:${relation.direction}`).map((group) => ({
    type: group[0].type,
    direction: group[0].direction,
    relations: group,
  }));
}

/** A connector URL safe to open: http(s) without credentials; null for anything else. */
export function connectorHref(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    const isWeb = url.protocol === "http:" || url.protocol === "https:";
    return isWeb && url.username.length === 0 && url.password.length === 0 ? url.href : null;
  } catch {
    return null;
  }
}
