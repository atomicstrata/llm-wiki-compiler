/**
 * markdown-it inline rule for `^[source.md]` citation markers.
 *
 * Each marker can carry one or more comma-separated source entries; the
 * rule emits ONE chip per parsed span (matching the spec's
 * "`^[a.md, b.md]` renders two chips" rule). Span suffixes are parsed in
 * both flavours: `:42-58` and `#L42-L58`. Malformed entries (a colon
 * with no line numbers, end-before-start, etc.) are dropped per
 * `extractClaimCitations`'s contract.
 *
 * Each chip carries the source filename, optional line range,
 * resolvability flag (true iff the source filename is present in the
 * snapshot's source-file list), and — on loopback binds only —
 * `data-absolute-path` plus an editor `data-editor-href`. Non-loopback
 * binds intentionally omit both so LAN viewers cannot learn the user's
 * filesystem layout, per the spec's §Support Rail rules.
 *
 * Rule placement (handled by `registerCitation`): registered AFTER the
 * built-in `link` rule so a `^[…]` embedded in link text gets folded
 * into the outer link's text rather than emitting a chip next to a
 * nested anchor; `shouldDeferInlineRule` then suppresses the rule
 * during the link's recursive inline parse. Code spans and fenced
 * blocks are handled earlier by markdown-it's own rules; escaped
 * `\^[…]` is stripped by the `escape` rule before this rule sees it.
 */

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import path from "path";
import { pathToFileURL } from "url";
import { extractClaimCitations } from "../utils/markdown.js";
import { escapeHtml, shouldDeferInlineRule } from "./markdown-it-helpers.js";
import type { ClaimCitation, SourceSpan } from "../utils/types.js";

const CHAR_CARET = 0x5e; // "^"
const CHAR_OPEN_BRACKET = 0x5b; // "["

/** Shared context the parser and renderer use to decorate each chip. */
interface CitationContext {
  /** Project root, used to compute `data-absolute-path` on loopback binds. */
  root: string;
  /** Filenames present under `sources/`, used to set the resolvability flag. */
  sourceFiles: ReadonlySet<string>;
  /** When false, omit `absolutePath` and editor links per §Support Rail. */
  isLoopback: boolean;
}

/** One chip's render-ready data. */
interface ChipMeta {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  resolved: boolean;
  absolutePath?: string;
  editorHref?: string;
}

/**
 * Register the rule and renderer on `md`. Registered AFTER the `link`
 * rule for the same reason as the wikilink rule (so a `^[…]` embedded in
 * link text gets included in the outer link's text, with the inner
 * recursive parse blocked by the `linkLevel` guard).
 */
export function registerCitation(md: MarkdownIt, context: CitationContext): void {
  md.inline.ruler.after("link", "citation", buildParser(context));
  md.renderer.rules.citation = (tokens: Token[], idx: number): string =>
    renderCitationToken(tokens[idx]);
}

/** Build the parser closure capturing the citation context. */
function buildParser(context: CitationContext) {
  return function parseCitation(state: StateInline, silent: boolean): boolean {
    if (state.src.charCodeAt(state.pos) !== CHAR_CARET) return false;
    if (state.src.charCodeAt(state.pos + 1) !== CHAR_OPEN_BRACKET) return false;
    if (shouldDeferInlineRule(state, silent)) return false;
    const closeAt = state.src.indexOf("]", state.pos + 2);
    if (closeAt < 0) return false;
    const inner = state.src.slice(state.pos + 2, closeAt);
    if (inner.includes("\n")) return false;
    const citations = extractClaimCitations(`^[${inner}]`);
    pushChipTokens(state, citations, context);
    state.pos = closeAt + 1;
    return true;
  };
}

/** Emit one `citation` token per parsed span (multi-source marker → multiple chips). */
function pushChipTokens(
  state: StateInline,
  citations: ClaimCitation[],
  context: CitationContext,
): void {
  for (const citation of citations) {
    for (const span of citation.spans) {
      const token = state.push("citation", "", 0);
      token.meta = buildChipMeta(span, context);
    }
  }
}

/** Construct the chip-meta record for a single source span. */
function buildChipMeta(span: SourceSpan, context: CitationContext): ChipMeta {
  const meta: ChipMeta = {
    file: span.file,
    lineStart: span.lines?.start,
    lineEnd: span.lines?.end,
    resolved: context.sourceFiles.has(span.file),
  };
  if (context.isLoopback && meta.resolved && isBareFilename(span.file)) {
    const absolutePath = path.join(context.root, "sources", span.file);
    meta.absolutePath = absolutePath;
    meta.editorHref = buildEditorHref(absolutePath, meta.lineStart);
  }
  return meta;
}

/**
 * Build the `vscode://file/...` editor href, percent-encoding the path
 * portion so URI delimiters inside source filenames (spaces, `#`, `?`,
 * `&`, `=`, `;`, etc.) cannot turn part of the filename into a URI
 * fragment, query, or parameter. Uses Node's `pathToFileURL().pathname`
 * because it percent-encodes every char that would change URI structure
 * while preserving path separators. Plain `encodeURI` preserves several
 * of those delimiters, so a filename like `notes #1?.md` would emit a
 * malformed href there.
 *
 * The `pathname` already starts with `/` (it is the absolute path), so
 * concatenating directly onto `vscode://file` yields a well-formed URI
 * with `file` as the authority and the encoded absolute path as the
 * path (e.g. `vscode://file/tmp/x.md`). The optional `:<line>` suffix
 * is appended AFTER encoding so vscode parses it as a line index, not
 * part of the path.
 */
function buildEditorHref(absolutePath: string, lineStart: number | undefined): string {
  const encodedPath = pathToFileURL(absolutePath).pathname;
  if (lineStart === undefined) return `vscode://file${encodedPath}`;
  return `vscode://file${encodedPath}:${lineStart}`;
}

/**
 * Conservative filename check: bare basename only, no separators, no
 * traversal segments. The citation rule never trusts a path-shaped
 * filename to begin with — if the source has slashes in it, we keep the
 * chip but skip the editor-link payload.
 */
function isBareFilename(file: string): boolean {
  if (file.length === 0) return false;
  if (file.includes("/") || file.includes("\\") || file.includes("\0")) return false;
  if (file === "." || file === "..") return false;
  return true;
}

/** Render one citation chip token. */
function renderCitationToken(token: Token): string {
  const meta = token.meta as ChipMeta;
  const label = formatChipLabel(meta);
  const attrs = chipAttributes(meta);
  return `<span ${attrs}>${escapeHtml(label)}</span>`;
}

/** Build the chip's data-* attribute string. */
function chipAttributes(meta: ChipMeta): string {
  const parts = [
    `class="citation-chip"`,
    `data-file="${escapeHtml(meta.file)}"`,
    `data-resolved="${meta.resolved ? "true" : "false"}"`,
  ];
  if (meta.lineStart !== undefined) {
    parts.push(`data-line-start="${meta.lineStart}"`);
  }
  if (meta.lineEnd !== undefined) {
    parts.push(`data-line-end="${meta.lineEnd}"`);
  }
  if (meta.absolutePath !== undefined) {
    parts.push(`data-absolute-path="${escapeHtml(meta.absolutePath)}"`);
  }
  if (meta.editorHref !== undefined) {
    parts.push(`data-editor-href="${escapeHtml(meta.editorHref)}"`);
  }
  return parts.join(" ");
}

/** Human-visible chip label: filename plus optional line range. */
function formatChipLabel(meta: ChipMeta): string {
  if (meta.lineStart === undefined) return meta.file;
  if (meta.lineEnd === undefined || meta.lineEnd === meta.lineStart) {
    return `${meta.file}:${meta.lineStart}`;
  }
  return `${meta.file}:${meta.lineStart}-${meta.lineEnd}`;
}

