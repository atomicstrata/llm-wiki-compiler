/**
 * Wiki page collector for the export subsystem.
 *
 * Thin wrapper over `src/wiki/collect.ts::collectRawWikiPages()` that
 * applies export-specific filters (drop orphaned and untitled pages) and
 * decorates each surviving record with the export-facing fields (summary,
 * sources, tags, timestamps, link slugs). The wikilink extraction regex
 * and slug-normalization helper live in `src/wiki/collect.ts` so both
 * export and viewer callers share one source.
 */

import path from "path";
import { collectRawWikiPages, extractWikilinkSlugs } from "../wiki/collect.js";
import type { RawWikiPage } from "../wiki/collect.js";
import { readConnectorBlock } from "../connectors/fence.js";
import { buildFreshnessSnapshot, computeFreshness } from "../freshness/index.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { extractClaimCitations } from "../utils/markdown.js";
import { flattenCitations } from "../context/provenance.js";
import type { PageKind } from "../schema/types.js";
import type { ProvenanceState, ContradictionRef } from "../utils/types.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import {
  hashPageBody,
  resolveSourceHashes,
  sourceHashLookupFromSnapshot,
  type SourceHashLookup,
} from "./provenance.js";
import type { ExportPage, PageDirectory, XOkfSnapshot } from "./types.js";

export { extractWikilinkSlugs };

/** Resolve the project-relative path for a wiki page (e.g. `wiki/concepts/retrieval.md`). */
function buildPagePath(pageDirectory: PageDirectory, slug: string): string {
  const dir = pageDirectory === "concepts" ? CONCEPTS_DIR : QUERIES_DIR;
  return path.posix.join(dir, `${slug}.md`);
}

/** Pull a typed string array out of frontmatter or return `[]` for missing/malformed input. */
function readStringArray(meta: Record<string, unknown>, field: string): string[] {
  const value = meta[field];
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((s): s is string => typeof s === "string");
}

/** Read a numeric confidence value if present and in the [0, 1] range. */
function readAdvisoryConfidence(meta: Record<string, unknown>): number | undefined {
  const value = meta.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/** Validate and return a ProvenanceState from frontmatter, or undefined. */
export function readProvenanceState(meta: Record<string, unknown>): ProvenanceState | undefined {
  const value = meta.provenanceState;
  if (
    value === "extracted" ||
    value === "merged" ||
    value === "inferred" ||
    value === "ambiguous" ||
    value === "imported"
  ) {
    return value;
  }
  return undefined;
}

/** Filter ContradictionRef entries to the documented `{ slug, reason? }` shape. */
function readContradictedBy(meta: Record<string, unknown>): ContradictionRef[] | undefined {
  const raw = meta.contradictedBy;
  if (!Array.isArray(raw)) return undefined;
  const refs: ContradictionRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.slug !== "string" || candidate.slug.length === 0) continue;
    const ref: ContradictionRef = { slug: candidate.slug };
    if (typeof candidate.reason === "string") ref.reason = candidate.reason;
    refs.push(ref);
  }
  return refs.length > 0 ? refs : undefined;
}

/** Read an imported page's `x-okf` snapshot (original OKF frontmatter + raw type), if present and well-formed. */
function readXOkf(meta: Record<string, unknown>): XOkfSnapshot | undefined {
  const x = meta["x-okf"];
  if (!x || typeof x !== "object") return undefined;
  const of = (x as Record<string, unknown>).originalFrontmatter;
  if (!of || typeof of !== "object") return undefined;
  const snap: XOkfSnapshot = { originalFrontmatter: of as Record<string, unknown> };
  const t = (x as Record<string, unknown>).type;
  if (typeof t === "string") snap.type = t;
  const p = (x as Record<string, unknown>).okfPath;
  if (typeof p === "string") snap.okfPath = p;
  return snap;
}

/** The two ISO-8601 instants every export format reports for a page. */
interface PageTimestamps {
  createdAt?: string;
  updatedAt?: string;
}

/** Read `field` from frontmatter when it holds a non-empty string. */
function readNonEmptyString(meta: Record<string, unknown>, field: string): string | undefined {
  const value = meta[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The instants a page actually declares — never the export run's clock.
 *
 * Stamping `new Date()` on a page that declares no timestamp was reachable in
 * ordinary use (`llmwiki query --save` writes `createdAt` and no `updatedAt`),
 * and it did two kinds of damage: two exports of an unchanged wiki differed,
 * and `llmwiki import --okf` mapped the invented instant back into real
 * frontmatter, where nothing distinguishes it from one the compiler recorded.
 * An undeclared field is therefore OMITTED — the key is absent, not empty —
 * matching how `src/pages/list.ts` reads these same two fields. Emitting `""`
 * would only move the invention downstream: every writer renders these fields,
 * and an empty date is a claim, not a silence.
 *
 * `updatedAt` falls back to `createdAt` — never the reverse. `query --save`
 * stamps a fresh `createdAt` on every save and rewrites the whole file through
 * an overwriting `atomicWrite`, so on a saved query `createdAt` genuinely
 * records when the page was last written, which is exactly what `updatedAt`
 * means on a compiled concept. Same reasoning as `src/viewer/page-fields.ts`,
 * restated here rather than imported: the export path must not depend on the
 * viewer.
 */
function readPageTimestamps(meta: Record<string, unknown>): PageTimestamps {
  const createdAt = readNonEmptyString(meta, "createdAt");
  const updatedAt = readNonEmptyString(meta, "updatedAt") ?? createdAt;
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

/** Validate and return PageKind from frontmatter, or undefined. */
function readPageKind(meta: Record<string, unknown>): PageKind | undefined {
  const value = meta.kind;
  if (value === "concept" || value === "entity" || value === "comparison" || value === "overview") {
    return value;
  }
  return undefined;
}

/**
 * Normalize a kept page into the shape every export writer consumes.
 * Caller is responsible for filtering out records that fail the export
 * gate (orphaned, untitled, unreadable). The bridge contract additions
 * (path, kind, advisory*, citations, aliases) are populated here so
 * every export format gets the same enriched payload.
 */
function toExportPage(
  raw: RawWikiPage,
  snapshot: FreshnessSnapshot,
  sourceHashes: SourceHashLookup,
): ExportPage {
  const meta = raw.frontmatter;
  const aliases = readStringArray(meta, "aliases");
  const sources = readStringArray(meta, "sources");
  const connectorOrigin = readConnectorBlock(meta);
  const freshness = computeFreshness(
    { slug: raw.slug, pageDirectory: raw.pageDirectory, frontmatter: meta },
    snapshot,
  );
  return {
    title: raw.title as string,
    slug: raw.slug,
    pageDirectory: raw.pageDirectory,
    path: buildPagePath(raw.pageDirectory, raw.slug),
    summary: typeof meta.summary === "string" ? meta.summary : "",
    sources,
    tags: readStringArray(meta, "tags"),
    ...readPageTimestamps(meta),
    links: extractWikilinkSlugs(raw.body),
    body: raw.body,
    kind: readPageKind(meta),
    ...(readXOkf(meta) ? { xOkf: readXOkf(meta)! } : {}),
    ...(connectorOrigin ? { connectorOrigin } : {}),
    advisoryConfidence: readAdvisoryConfidence(meta),
    provenanceState: readProvenanceState(meta),
    contradictedBy: readContradictedBy(meta),
    citations: flattenCitations(extractClaimCitations(raw.body)),
    ...(aliases.length > 0 ? { aliases } : {}),
    freshnessStatus: freshness.freshnessStatus,
    contradicted: freshness.contradicted,
    archived: freshness.archived,
    contentHash: hashPageBody(raw.body),
    sourceHashes: resolveSourceHashes(sources, sourceHashes),
    ...(typeof meta.modelId === "string" ? { modelId: meta.modelId } : {}),
    ...(typeof meta.promptVersion === "string" ? { promptVersion: meta.promptVersion } : {}),
  };
}

/**
 * Collect all exportable wiki pages from `wiki/concepts/` and `wiki/queries/`.
 * Drops untitled records, frontmatter-orphaned records, and computed-orphaned
 * records (every owning source deleted) — those are diagnosed by lint/the
 * viewer, not exported. The freshness snapshot is built once and shared across
 * all pages. Returns the surviving pages sorted by title.
 */
export async function collectExportPages(root: string): Promise<ExportPage[]> {
  const raw = await collectRawWikiPages(root);
  const snapshot = await buildFreshnessSnapshot(root);
  const sourceHashes = sourceHashLookupFromSnapshot(snapshot);
  const kept = raw.filter((page) => page.parseStatus.hasTitle && !page.parseStatus.orphaned);
  const pages = kept
    .map((page) => toExportPage(page, snapshot, sourceHashes))
    .filter((page) => page.freshnessStatus !== "orphaned");
  pages.sort((a, b) => a.title.localeCompare(b.title));
  return pages;
}
