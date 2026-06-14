/**
 * @file Shared, reversible OKF<->llmwiki mapping core (used by export and the
 * later import plan): canonical body + hashing, frontmatter mapping, link rewrite.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExportPage } from "../types.js";
import type { OkfFrontmatter, XLlmwiki, LinkResolver } from "./types.js";
import { slugify } from "../../utils/markdown.js";

const DERIVED_CITATIONS = /\n+#\s+Citations\b[\s\S]*$/;

/** Canonical body = body WITHOUT the derived `# Citations` section, single trailing newline. */
export function canonicalBody(body: string): string {
  return body.replace(DERIVED_CITATIONS, "").replace(/\s*$/, "") + "\n";
}

/** Authoritative contentHash domain: sha256 of the canonical body. */
function hashCanonicalBody(body: string): string {
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

/** ExportPage -> OKF frontmatter. `type` is always non-empty (defaults to "concept"). */
export function mapPageToOkfFrontmatter(page: ExportPage): OkfFrontmatter {
  const x: XLlmwiki = {
    schemaVersion: "0.1",
    contentHash: hashCanonicalBody(page.body),
    pageDirectory: page.pageDirectory,
  };
  if (page.sources?.length) x.sources = page.sources;
  if (page.advisoryConfidence !== undefined) x.confidence = page.advisoryConfidence;
  if (page.provenanceState) x.provenanceState = page.provenanceState;
  if (page.contradictedBy?.length) x.contradictedBy = page.contradictedBy;
  if (page.freshnessStatus) x.freshnessStatus = page.freshnessStatus;
  if (page.aliases?.length) x.aliases = page.aliases;
  if (page.citations?.length) x.citations = page.citations;

  const fm: OkfFrontmatter = { type: page.kind ?? "concept", "x-llmwiki": x };
  if (page.title) fm.title = page.title;
  if (page.summary) fm.description = page.summary;
  if (page.tags?.length) fm.tags = page.tags;
  if (page.updatedAt) fm.timestamp = page.updatedAt;
  return fm;
}

const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const OKF_LINK = /\[([^\]]+)\]\(\/(concepts|queries)\/([^)]+?)\.md\)/g;
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g; // capturing → fenced blocks at odd split indices
// Only fenced blocks are protected; single-backtick inline code (e.g. `[[x]]`)
// is NOT — a wikilink inside inline code will still be rewritten. Acceptable for v0.1.

/** Forward: rewrite resolvable [[slug]]/[[slug|disp]] to OKF links, SKIPPING fenced code. */
export function wikilinksToOkf(body: string, resolve: LinkResolver): string {
  return body
    .split(FENCE)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(WIKILINK, (match, rawSlug: string, disp?: string) => {
            const slug = slugify(rawSlug);
            const target = resolve(slug);
            if (!target) return match;
            return `[${disp ?? target.title}](/${target.dir}/${slug}.md)`;
          }),
    )
    .join("");
}

/** Reverse: OKF link -> [[slug]] when text == target title, else [[slug|text]]. */
export function okfLinksToWikilinks(body: string, titleOf: (slug: string) => string | null): string {
  return body.replace(OKF_LINK, (_m, text: string, _dir: string, slug: string) => {
    const title = titleOf(slug);
    return title !== null && text === title ? `[[${slug}]]` : `[[${slug}|${text}]]`;
  });
}
