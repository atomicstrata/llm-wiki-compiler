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
 * Derive a single safe slug from a bundle-relative path. `slugify` deletes `/`,
 * so separators are converted to `-` first — `concepts/rag.md` -> `concepts-rag`.
 * MUST be the only slug-derivation path (shared with the import title resolver).
 */
export function slugFromRelPath(relPath: string): string {
  return slugify(relPath.replace(/\.md$/i, "").replace(/[/\\]+/g, "-"));
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

/** Copy x-llmwiki passthrough fields onto the page frontmatter under collect.ts's read keys. */
function applyXLlmwiki(fields: Record<string, unknown>, x: Record<string, unknown>): void {
  const aliases = asStringArray(x.aliases);
  if (aliases.length) fields.aliases = aliases;
  if (typeof x.confidence === "number") fields.confidence = x.confidence;
  if (Array.isArray(x.contradictedBy) && x.contradictedBy.length) fields.contradictedBy = x.contradictedBy;
}

/** Base llmwiki frontmatter every imported page carries, before x-llmwiki passthrough. */
function baseFields(meta: Record<string, unknown>, ctx: OkfMapContext, slug: string): Record<string, unknown> {
  const x = (meta["x-llmwiki"] ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    title: pickString(meta.title, humanize(slug)),
    summary: typeof meta.description === "string" ? meta.description : "",
    sources: Array.from(new Set([...asStringArray(x.sources), `okf:${ctx.bundleId}`])),
    kind: KNOWN_KINDS.has(meta.type as string) ? (meta.type as PageKind) : "concept",
    createdAt: now,
    updatedAt: typeof meta.timestamp === "string" ? meta.timestamp : now,
    provenanceState: "imported",
  };
}

/** Verbatim snapshot of the source frontmatter; records the raw `type` only when foreign. */
function buildXokf(meta: Record<string, unknown>): Record<string, unknown> {
  const rawType = typeof meta.type === "string" ? meta.type : "concept";
  const known = KNOWN_KINDS.has(rawType);
  return { ...(known ? {} : { type: rawType }), originalFrontmatter: meta };
}

/** Assemble the llmwiki frontmatter fields from OKF standard + x-llmwiki blocks. */
function buildPageFields(doc: RawOkfDoc, ctx: OkfMapContext, slug: string): Record<string, unknown> {
  const meta = doc.meta;
  const fields = baseFields(meta, ctx, slug);
  if (Array.isArray(meta.tags)) fields.tags = asStringArray(meta.tags);
  applyXLlmwiki(fields, (meta["x-llmwiki"] ?? {}) as Record<string, unknown>);
  fields["x-okf"] = buildXokf(meta);
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
  const body = isNative ? okfLinksToWikilinks(canonicalBody(doc.body), ctx.titleOf) : doc.body;
  const pageBody = `${buildFrontmatter(fields)}\n\n${body.replace(/\s*$/, "")}\n`;
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
