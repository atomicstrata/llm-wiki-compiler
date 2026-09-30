/**
 * @file Shared, reversible OKF<->llmwiki mapping core (used by export and the
 * later import plan): canonical body + hashing, frontmatter mapping, link rewrite.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExportPage } from "../types.js";
import type { OkfFrontmatter, XLlmwiki, LinkResolver } from "./types.js";
import { slugify } from "../../utils/markdown.js";
import { isLiteralMarkdown } from "../../compiler/link-repair-code.js";
import { rewriteWikilinks } from "../../wiki/wikilinks.js";

const DERIVED_CITATIONS = /\n+#\s+Citations\b[\s\S]*$/;

/** Canonical body = body WITHOUT the derived `# Citations` section, single trailing newline. */
export function canonicalBody(body: string): string {
  return body.replace(DERIVED_CITATIONS, "").replace(/\s*$/, "") + "\n";
}

/** Authoritative contentHash domain: sha256 of the canonical body. */
export function hashCanonicalBody(body: string): string {
  return createHash("sha256").update(canonicalBody(body), "utf-8").digest("hex");
}

/**
 * Encode an arbitrary cited source filename into a SAFE, flat, INJECTIVE
 * `references/` filename: strips leading traversal/separators and flattens path
 * separators for a readable base, then appends a short stable hash of the
 * ORIGINAL path before the extension. The hash makes distinct sources that would
 * otherwise collapse to the same flat base (e.g. `a/b.md` vs `a__b.md`) map to
 * distinct names, so distinct sources can never overwrite one another. The SAME
 * function MUST be used for both the citation link and the copied file so they match.
 */
export function safeRefName(file: string): string {
  const base = file.replace(/^[./\\]+/, "").replace(/[/\\]+/g, "__").replace(/[^\w.\-]+/g, "_");
  const hash = createHash("sha256").update(file).digest("hex").slice(0, 8);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}-${hash}${ext}`;
}

/**
 * Optional x-llmwiki fields, each paired with how to read its value off a page.
 * Table-driven so {@link buildXLlmwiki} stays a single flat copy loop (no branch
 * per field) — a non-empty value is copied, everything else is dropped.
 */
const OPTIONAL_XLLMWIKI_FIELDS: ReadonlyArray<readonly [keyof XLlmwiki, (p: ExportPage) => unknown]> = [
  ["sources", (p) => p.sources],
  ["confidence", (p) => p.advisoryConfidence],
  ["provenanceState", (p) => p.provenanceState],
  ["contradictedBy", (p) => p.contradictedBy],
  ["freshnessStatus", (p) => p.freshnessStatus],
  ["aliases", (p) => p.aliases],
  ["citations", (p) => p.citations],
];

/** True for values worth copying onto x-llmwiki: defined, and non-empty when array. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return Array.isArray(value) ? value.length > 0 : true;
}

/** Build the refreshed x-llmwiki provenance block for a page (contentHash recomputed from the current body). */
function buildXLlmwiki(page: ExportPage): XLlmwiki {
  const x: XLlmwiki = {
    schemaVersion: "0.1",
    contentHash: hashCanonicalBody(page.body),
    pageDirectory: page.pageDirectory,
  };
  for (const [field, read] of OPTIONAL_XLLMWIKI_FIELDS) {
    const value = read(page);
    if (isPresent(value)) (x as unknown as Record<string, unknown>)[field] = value;
  }
  return x;
}

// Keys derived fresh from the CURRENT page (or llmwiki-owned), so they are stripped from
// the captured foreign snapshot before its unknown producer keys are carried through. Note
// `okfPath` lives on the x-okf block, not here; re-export deliberately omits x-okf entirely.
const RECONSTRUCT_STRIP = ["type", "title", "description", "tags", "timestamp", "x-llmwiki", "x-okf"];

/** OKF `type` used when nothing better is known about a document. */
const DEFAULT_OKF_TYPE = "concept";
/** OKF `type` for a page living in `wiki/queries/` — a saved `llmwiki query` answer. */
const QUERY_OKF_TYPE = "query";

/** Overlay the OKF standard fields from the CURRENT page so local edits are always reflected. */
function applyStandardFields(fm: Record<string, unknown>, page: ExportPage): void {
  if (page.title) fm.title = page.title;
  if (page.summary) fm.description = page.summary;
  if (page.tags?.length) fm.tags = page.tags;
  if (page.updatedAt) fm.timestamp = page.updatedAt;
}

/**
 * Re-export an imported page: keep the raw foreign `type` and any unknown producer
 * keys from the captured snapshot, but derive the OKF standard fields (title,
 * description, tags, timestamp) from the CURRENT page so local edits are reflected,
 * and refresh x-llmwiki. (Preserve foreign keys, not stale standard frontmatter.)
 *
 * Re-export's output PATH for a foreign doc is decided by `resolveOutputPaths` (restoring
 * `x-okf.okfPath` when safe); this function governs only the frontmatter reconstruction
 * (raw foreign type/keys + refreshed x-llmwiki).
 */
function reconstructForeignFrontmatter(page: ExportPage, x: XLlmwiki): OkfFrontmatter {
  const of = page.xOkf!.originalFrontmatter;
  const rawType = typeof of.type === "string" && of.type.trim() ? of.type : (page.xOkf!.type ?? DEFAULT_OKF_TYPE);
  const extras: Record<string, unknown> = { ...of };
  for (const k of RECONSTRUCT_STRIP) delete extras[k];
  const fm: Record<string, unknown> = { ...extras, type: rawType, "x-llmwiki": x };
  applyStandardFields(fm, page);
  return fm as unknown as OkfFrontmatter;
}

/**
 * OKF `type` for a NATIVE page: its declared `kind`, else its directory.
 *
 * A saved query declares a top-level `type: "query"` and no `kind` (see
 * `src/commands/query-save.ts`), so reading `kind` alone published every saved
 * answer as a `concept` — an actively wrong document type, not a missing one.
 * The directory is the right substitute rather than the frontmatter `type`:
 * everything under `wiki/queries/` is a saved query, it is present on every
 * page, and it is already the signal import treats as authoritative
 * (`x-llmwiki.pageDirectory` decides the import target directory).
 *
 * OKF `type` is a free-form non-empty string — the profile export emits
 * arbitrary entity-type ids there — so `"query"` is a legal value, and the
 * importer preserves an unknown foreign `type` verbatim inside `x-okf`, so a
 * saved query re-exports as a query on every subsequent round trip.
 */
function nativeOkfType(page: ExportPage): string {
  if (page.kind) return page.kind;
  return page.pageDirectory === "queries" ? QUERY_OKF_TYPE : DEFAULT_OKF_TYPE;
}

/** ExportPage -> OKF frontmatter. `type` is always non-empty (defaults to "concept"). */
export function mapPageToOkfFrontmatter(page: ExportPage): OkfFrontmatter {
  const x = buildXLlmwiki(page);
  if (page.xOkf) return reconstructForeignFrontmatter(page, x);
  const fm: Record<string, unknown> = { type: nativeOkfType(page), "x-llmwiki": x };
  applyStandardFields(fm, page);
  return fm as unknown as OkfFrontmatter;
}

// any bundle-relative markdown link to a `.md` doc: captures display text + path (no leading slash, no .md)
const OKF_LINK = /\[([^\]]+)\]\(\/([^)]+?)\.md\)/g;

/**
 * Forward: rewrite resolvable [[slug]]/[[slug|disp]] to OKF links. Only text the
 * renderer reads as a link is rewritten; code, escaped brackets and link text
 * stay verbatim, matching link repair and publication.
 */
export function wikilinksToOkf(body: string, resolve: LinkResolver): string {
  return rewriteWikilinks(body, ({ inner }) => {
    const bar = inner.indexOf("|");
    const disp = bar < 0 ? undefined : inner.slice(bar + 1) || undefined;
    const target = resolve(slugify(bar < 0 ? inner : inner.slice(0, bar)));
    return target ? `[${disp ?? target.title}](/${target.path})` : undefined;
  });
}

/**
 * Reverse: OKF link -> [[slug]] when `resolveLink(path)` maps the link's path to a known
 * bundle doc; an unknown/external path is left verbatim. `[[slug]]` when text === title,
 * else `[[slug|text]]`. Links inside literal Markdown stay verbatim, mirroring the forward
 * direction, so a round trip never turns a code example into a wikilink.
 */
export function okfLinksToWikilinks(
  body: string,
  resolveLink: (linkPath: string) => { slug: string; title: string } | null,
): string {
  const literal = isLiteralMarkdown(body);
  return body.replace(OKF_LINK, (match: string, text: string, linkPath: string, offset: number) => {
    if (literal(offset)) return match;
    const r = resolveLink(linkPath);
    if (!r) return match;
    return r.title === text ? `[[${r.slug}]]` : `[[${r.slug}|${text}]]`;
  });
}
