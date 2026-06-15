/**
 * @file Inverse OKF->llmwiki mapping for a single bundle doc. Produces a complete
 * llmwiki page (frontmatter + body) carrying a durable `imported` provenance and a
 * verbatim `x-okf` snapshot, reversing the shared link rewrite for native docs.
 */
import { slugify, buildFrontmatter } from "../utils/markdown.js";
import { canonicalBody, okfLinksToWikilinks } from "../export/okf/mapping.js";
import { PAGE_KINDS } from "../schema/types.js";
import type { PageKind } from "../schema/types.js";
import type { MappedOkfPage, RawOkfDoc } from "./types.js";

/** Resolution context: titles of sibling docs in this bundle + a stable bundle id. */
export interface OkfMapContext { bundleId: string; titleOf: (slug: string) => string | null; }

const KNOWN_KINDS = new Set<string>(PAGE_KINDS);

/**
 * Derive a single safe slug from a bundle-relative path. The repo `slugify` deletes `/`,
 * so separators become `-` first. A leading `concepts/`|`queries/` page-dir prefix is
 * stripped so a native doc keeps its flat llmwiki slug (`concepts/rag.md` -> `rag`),
 * which matches both the original slug and `okfLinksToWikilinks`' bare-slug extraction;
 * genuinely-nested foreign paths (`tables/customers.md` -> `tables-customers`) stay distinct.
 * MUST be the only slug-derivation path (shared with the import title resolver).
 */
export function slugFromRelPath(relPath: string): string {
  const noExt = relPath.replace(/\.md$/i, "");
  const stripped = noExt.replace(/^(concepts|queries)\//, "");
  return slugify(stripped.replace(/[/\\]+/g, "-"));
}

function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveTargetDir(meta: Record<string, unknown>, relPath: string): "concepts" | "queries" {
  const x = meta["x-llmwiki"] as { pageDirectory?: unknown } | undefined;
  if (x?.pageDirectory === "concepts" || x?.pageDirectory === "queries") return x.pageDirectory;
  return relPath.startsWith("queries/") ? "queries" : "concepts";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === "string") : [];
}

function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/**
 * Copy SAFE x-llmwiki passthrough onto the page frontmatter. An imported bundle's
 * x-llmwiki is attacker-controllable, so we deliberately do NOT promote `aliases`
 * (wikilink-resolution vector) or `contradictedBy` (references local slugs a foreign
 * producer can't legitimately know) to ACTIVE fields — they survive only inside the
 * `x-okf.originalFrontmatter` snapshot. `confidence` is advisory (not used in ranking).
 */
function applyXLlmwiki(fields: Record<string, unknown>, x: Record<string, unknown>): void {
  if (typeof x.confidence === "number") fields.confidence = x.confidence;
}

/** Base llmwiki frontmatter every imported page carries, before x-llmwiki passthrough. */
function baseFields(meta: Record<string, unknown>, ctx: OkfMapContext, slug: string): Record<string, unknown> {
  const x = (meta["x-llmwiki"] ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    title: pickString(meta.title, humanize(slug)),
    summary: typeof meta.description === "string" ? meta.description : "",
    // Strip any PRIOR `okf:` origin tokens before stamping the current bundle's, so a
    // repeated export->import->export->import cycle keeps exactly one origin token.
    sources: Array.from(new Set([
      ...asStringArray(x.sources).filter((s) => !s.startsWith("okf:")),
      `okf:${ctx.bundleId}`,
    ])),
    kind: KNOWN_KINDS.has(meta.type as string) ? (meta.type as PageKind) : "concept",
    // Lossy across an OKF round-trip: `createdAt` is reset to now (OKF carries only
    // `timestamp`, mapped to `updatedAt`); `modelId`/`promptVersion` are llmwiki-internal
    // lineage with no OKF representation, so they are not preserved on re-import.
    createdAt: now,
    updatedAt: typeof meta.timestamp === "string" ? meta.timestamp : now,
    provenanceState: "imported",
  };
}

/**
 * Verbatim snapshot of the source frontmatter; records the raw `type` only when foreign.
 * `okfPath` durably records the doc's bundle-relative source path so the original OKF
 * identity survives review approval (the candidate-only `okfPath` is lost once live).
 */
function buildXokf(meta: Record<string, unknown>, okfPath: string): Record<string, unknown> {
  const rawType = typeof meta.type === "string" ? meta.type : "concept";
  const known = KNOWN_KINDS.has(rawType);
  return { ...(known ? {} : { type: rawType }), okfPath, originalFrontmatter: meta };
}

/** Assemble the llmwiki frontmatter fields from OKF standard + x-llmwiki blocks. */
function buildPageFields(doc: RawOkfDoc, ctx: OkfMapContext, slug: string): Record<string, unknown> {
  const meta = doc.meta;
  const fields = baseFields(meta, ctx, slug);
  if (Array.isArray(meta.tags)) fields.tags = asStringArray(meta.tags);
  applyXLlmwiki(fields, (meta["x-llmwiki"] ?? {}) as Record<string, unknown>);
  fields["x-okf"] = buildXokf(meta, doc.relPath);
  return fields;
}

/** Map one OKF doc to a llmwiki page record (frontmatter + body, ready to stage or write). */
export function okfDocToPage(doc: RawOkfDoc, ctx: OkfMapContext): MappedOkfPage {
  const slug = slugFromRelPath(doc.relPath);
  const fields = buildPageFields(doc, ctx, slug);
  const isNative = doc.meta["x-llmwiki"] !== undefined;
  // NOTE: canonicalBody strips a derived `# Citations` section on BOTH export and import
  // (symmetric, so round-trip canonical equality holds); an author-written `# Citations`
  // in a native page is likewise dropped. Foreign bodies are kept content-verbatim.
  const resolveLink = (linkPath: string): { slug: string; title: string } | null => {
    const linkSlug = slugFromRelPath(linkPath);
    const title = ctx.titleOf(linkSlug);
    return title !== null ? { slug: linkSlug, title } : null;
  };
  // A foreign body is kept verbatim on FIRST import, but re-export stamps an `x-llmwiki` block, so a
  // SUBSEQUENT import sees it as native and rewrites its markdown links to [[wikilinks]]. The first
  // round-trip is faithful; multi-hop "llmwiki-ifies" the link syntax — intentional (it's a llmwiki page by then).
  const body = isNative ? okfLinksToWikilinks(canonicalBody(doc.body), resolveLink) : doc.body;
  // Join with a SINGLE newline, mirroring the exporter's render-doc convention
  // (`${frontmatter}\n${body}`). The canonical body already carries its own leading
  // blank line, so this keeps the export->import round-trip byte-symmetric.
  const pageBody = `${buildFrontmatter(fields)}\n${body}`;
  return {
    slug,
    title: fields.title as string,
    summary: fields.summary as string,
    sources: fields.sources as string[],
    targetDirectory: resolveTargetDir(doc.meta, doc.relPath),
    okfPath: doc.relPath,
    body: pageBody,
  };
}
