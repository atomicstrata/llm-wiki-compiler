/**
 * Bounded per-entity context built only from the startup snapshot's pages,
 * relation instances, source names and durable connector provenance. No file
 * reads occur here or when this projection is served. Missing/invalid endpoint
 * pages stay visible as unresolved rather than silently erasing a relation.
 */
import { readConnectorBlock } from "../connectors/fence.js";
import type { SourceSpan } from "../utils/types.js";
import type { RelationEdge } from "./graph.js";
import type { ViewerPage } from "./types.js";

const CONTEXT_LIMIT = 100;
const LABEL_LIMIT = 256;

export interface EntityRelationContext {
  type: string;
  direction: "incoming" | "outgoing" | "symmetric";
  target: { id: string; resolved: boolean; title?: string };
}

export interface EntitySourceContext extends SourceSpan { resolved: boolean }

export interface EntityContext {
  relations: EntityRelationContext[];
  relationTotal: number;
  sources: EntitySourceContext[];
  sourceTotal: number;
  connector?: {
    connectorId: string; connectorVersion: string; fetchedAt: string;
    contentHash: string; sourceUrl?: string;
  };
}

/** Only navigable web origins without embedded credentials reach this surface. */
function connectorUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}

/** Project host-authored metadata provenance, never labeling it a publication. */
function connectorContext(page: ViewerPage): EntityContext["connector"] {
  const block = readConnectorBlock(page.frontmatter);
  if (!block) return undefined;
  const sourceUrl = connectorUrl(block.sourceUrl);
  return {
    connectorId: block.connectorId.slice(0, LABEL_LIMIT),
    connectorVersion: block.connectorVersion.slice(0, LABEL_LIMIT),
    fetchedAt: block.fetchedAt.slice(0, LABEL_LIMIT),
    contentHash: block.contentHash,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/** Keep source entry identifiers relative and separate from local file paths. */
function safeSourceName(file: string): boolean {
  return file.length > 0 && file.length <= LABEL_LIMIT && !/[/\\\x00-\x1f]/.test(file) && file !== "." && file !== "..";
}

/** De-duplicate explicit source spans without inventing a source for a page. */
function sourcesFor(page: ViewerPage, sourceNames: ReadonlySet<string>): EntitySourceContext[] {
  const spans = sourceSpans(page);
  const unique = new Map<string, EntitySourceContext>();
  for (const span of spans.filter(span => safeSourceName(span.file))) {
    const key = `${span.file}:${span.lines?.start ?? ""}:${span.lines?.end ?? ""}`;
    unique.set(key, { ...span, resolved: sourceNames.has(span.file) });
  }
  return [...unique.values()].sort(compareSources);
}

/** Stable order preserves separate cited ranges for the same raw source. */
function compareSources(a: EntitySourceContext, b: EntitySourceContext): number {
  return a.file.localeCompare(b.file) || (a.lines?.start ?? 0) - (b.lines?.start ?? 0);
}

/** Add declared source ownership only when a citation does not already represent it. */
function sourceSpans(page: ViewerPage): SourceSpan[] {
  const spans = page.citations.flatMap(citation => citation.spans);
  const declared = page.frontmatter.sources;
  if (Array.isArray(declared)) {
    for (const file of declared) {
      if (typeof file === "string" && !spans.some(span => span.file === file)) spans.push({ file });
    }
  }
  return spans;
}

/** Project one endpoint relative to the current page, preserving direction. */
function relationFor(page: ViewerPage, relation: RelationEdge, pages: ReadonlyMap<string, ViewerPage>): EntityRelationContext {
  const outgoing = relation.from === page.id;
  const id = outgoing ? relation.to : relation.from;
  const target = pages.get(id);
  return {
    type: relation.type,
    direction: relation.direction === "symmetric" ? "symmetric" : outgoing ? "outgoing" : "incoming",
    target: { id, resolved: target !== undefined, ...(target ? { title: target.title.slice(0, LABEL_LIMIT) } : {}) },
  };
}

/** Attach the frozen projection only to typed pages; keep default pages intact. */
export function attachEntityContexts(pages: ViewerPage[], relations: RelationEdge[], filenames: string[]): ViewerPage[] {
  const byId = new Map(pages.map(page => [page.id as string, page]));
  const sources = new Set(filenames);
  return pages.map(page => {
    if (page.entityType === undefined) return page;
    const related = relations.filter(relation => relation.from === page.id || relation.to === page.id)
      .map(relation => relationFor(page, relation, byId))
      .sort((a, b) => `${a.type}:${a.direction}:${a.target.id}`.localeCompare(`${b.type}:${b.direction}:${b.target.id}`));
    const evidence = sourcesFor(page, sources);
    const connector = connectorContext(page);
    return { ...page, entityContext: {
      relations: related.slice(0, CONTEXT_LIMIT), relationTotal: related.length,
      sources: evidence.slice(0, CONTEXT_LIMIT), sourceTotal: evidence.length,
      ...(connector ? { connector } : {}),
    } };
  });
}
