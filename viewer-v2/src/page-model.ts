/**
 * Facts derived from a page payload and the bootstrap envelope that the page
 * view and its support rail show: the heading rules of the original client,
 * citations grouped by source file, the source-file count under the title,
 * backlinks, a typed page's declared fields, and relation groups. Pure
 * functions, so the rules are tested without a fetch or a DOM.
 */
import type { ClaimCitation, EntityRelation, PagePayload, PagesEnvelope, SourceSpan } from "./api";
import { TIMELINE_DIRECTORY, timelinePeriod } from "./timeline-model";
import { humanLabel, plural } from "./wiki-model";

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

/** Whether a page is a generated timeline day or week, written by compile from the sources' dates. */
export function isTimelinePage(page: Pick<PagePayload, "pageDirectory" | "slug">): boolean {
  return page.pageDirectory === TIMELINE_DIRECTORY && timelinePeriod(page.slug) !== null;
}

/** The display kind: day or week for a timeline page, else frontmatter `kind`, the saved-query `type`, the entity type, or concept. */
export function pageKind(page: PagePayload): string {
  const period = page.pageDirectory === TIMELINE_DIRECTORY ? timelinePeriod(page.slug) : null;
  if (period) return period;
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

/**
 * The distinct source files a page draws on, from its citations and a typed
 * page's entity sources, with how many are missing on disk. `partial` says the
 * server listed only some of the entity's sources, so there may be more files.
 */
export function sourceFileTally(page: PagePayload, sourceFilenames: string[]): { total: number; missing: number; partial: boolean } {
  const known = new Set(sourceFilenames);
  const found = new Map(page.citations.flatMap((citation) => citation.spans).map((span) => [span.file, known.has(span.file)]));
  const context = page.entityContext;
  for (const source of context?.sources ?? []) found.set(source.file, source.resolved);
  const missing = [...found.values()].filter((resolved) => !resolved).length;
  return { total: found.size, missing, partial: context !== undefined && context.sourceTotal > context.sources.length };
}

/** The meta line's source phrase, e.g. "From 3 source files (1 missing)"; empty when the page draws on none. */
export function sourceFilesLabel({ total, missing, partial }: { total: number; missing: number; partial: boolean }): string {
  if (total === 0) return "";
  const count = partial ? `${total}+ source files` : plural(total, "source file");
  return `From ${count}${missing > 0 ? ` (${missing} missing)` : ""}`;
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

/**
 * The pages whose wikilinks name this one, by title. The server lists them from
 * every page's own links, so a timeline day or a typed page counts too, though
 * neither is a wikilink node in the graph.
 */
export function backlinksFrom(page: PagePayload, wiki: PagesEnvelope): Backlink[] {
  const titles = new Map(wiki.pages.map((row) => [row.id, row.title]));
  return [...new Set(page.backlinks)]
    .map((id) => ({ id, title: titles.get(id) || id }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** One field a typed page's profile declares, as the rail shows it. */
export interface DeclaredField {
  name: string;
  label: string;
  value: string;
}

/**
 * A typed page's declared field values in the profile's declaration order,
 * read from its frontmatter. The title field is left out, since it is the
 * heading, and so is any field the page does not fill in.
 */
export function declaredFields(page: PagePayload, wiki: PagesEnvelope): DeclaredField[] {
  const type = wiki.profilePipeline?.entityTypes.find((row) => row.type === page.entityType);
  if (page.entityType === undefined || type === undefined) return [];
  return (type.fields ?? [])
    .filter((field) => field.name !== type.titleField)
    .map((field) => ({ name: field.name, label: humanLabel(field.name), value: fieldText(ownValue(page.frontmatter, field.name)) }))
    .filter((field) => field.value.length > 0);
}

/** A frontmatter value by its own key only, so a field named `constructor` is not `Object`. */
function ownValue(frontmatter: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(frontmatter, name) ? frontmatter[name] : undefined;
}

/** A field value as one line: a list joined by commas, a boolean as Yes or No; empty when there is nothing. */
function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.map(fieldText).filter((item) => item.length > 0).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return value === null || value === undefined ? "" : JSON.stringify(value);
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
