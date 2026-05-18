/**
 * markdown-it inline rule for `[[wikilink]]` and `[[wikilink|alias]]`.
 *
 * Resolved wikilinks become hash-routed anchors carrying a `data-page-id`
 * attribute the client uses to mark the active sidebar entry. Unresolved
 * wikilinks render as a visible `<span data-missing="true">[[slug]]</span>`
 * so the user can see (and fix) broken provenance instead of silently
 * dropping the target.
 *
 * Rule placement (handled by `registerWikilink`): registered AFTER the
 * built-in `link` rule. The link rule needs first crack at `[ … ](url)`
 * so a `[[wikilink]]` embedded in link text gets folded into the outer
 * link's text rather than emitting a nested anchor; the recursive parse
 * that happens inside link text is then suppressed by `shouldDeferInlineRule`
 * (link-level + silent-mode guards). Code spans and fenced code blocks
 * are handled earlier by markdown-it's own rules; escaped sequences are
 * stripped by the `escape` rule before this rule sees them. All four
 * contexts render the `[[…]]` marker as literal text per the spec's
 * §Slice 4 "code-span / fenced / escaped / link-text" audit item.
 */

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { resolveBareSlug } from "./collect.js";
import { slugify } from "../utils/markdown.js";
import { escapeHtml, shouldDeferInlineRule } from "./markdown-it-helpers.js";
import type { PageId, ViewerPage } from "./types.js";

const OPEN = "[";
const CHAR_OPEN_BRACKET = 0x5b; // "["

/** Internal context the parser and renderer share for a single render call. */
interface WikilinkContext {
  pages: ReadonlyArray<ViewerPage>;
}

/**
 * Register the wikilink inline rule and its renderer on `md`. The
 * `context` is captured by closure so the parser/renderer functions stay
 * pure of markdown-it's plugin-options shape.
 *
 * Registered AFTER the built-in `link` rule (not before): the link rule
 * needs first crack at `[ … ](url)` so a wikilink embedded in link text
 * like `[See [[alpha]] reference](url)` is consumed as part of the outer
 * link, with our wikilink later inhibited by the `linkLevel` guard while
 * the link's recursive inline parse runs.
 */
export function registerWikilink(md: MarkdownIt, context: WikilinkContext): void {
  md.inline.ruler.after("link", "wikilink", buildParser(context));
  md.renderer.rules.wikilink = (tokens: Token[], idx: number): string =>
    renderWikilinkToken(tokens[idx]);
}

/** Build the inline parser closure capturing the snapshot context. */
function buildParser(context: WikilinkContext) {
  return function parseWikilink(state: StateInline, silent: boolean): boolean {
    if (state.src.charCodeAt(state.pos) !== CHAR_OPEN_BRACKET) return false;
    if (state.src.charCodeAt(state.pos + 1) !== CHAR_OPEN_BRACKET) return false;
    if (shouldDeferInlineRule(state, silent)) return false;
    const closeAt = state.src.indexOf("]]", state.pos + 2);
    if (closeAt < 0) return false;
    const inner = state.src.slice(state.pos + 2, closeAt);
    // Markdown convention: forbid newlines inside a single wikilink span.
    if (inner.includes("\n") || inner.includes(OPEN)) return false;
    const { rawTarget, display } = splitTargetAndAlias(inner);
    const slug = slugify(rawTarget.trim());
    const resolved = resolveBareSlug(slug, context.pages);
    pushWikilinkToken(state, resolved, slug, display);
    state.pos = closeAt + 2;
    return true;
  };
}

/** Split the inside-brackets text into a raw target and a display label. */
function splitTargetAndAlias(inner: string): { rawTarget: string; display: string } {
  const pipe = inner.indexOf("|");
  if (pipe < 0) return { rawTarget: inner, display: inner.trim() };
  return {
    rawTarget: inner.slice(0, pipe),
    display: inner.slice(pipe + 1).trim() || inner.slice(0, pipe).trim(),
  };
}

/** Push a single wikilink token onto the parser state. */
function pushWikilinkToken(
  state: StateInline,
  resolved: PageId | null,
  slug: string,
  display: string,
): void {
  const token = state.push("wikilink", "", 0);
  token.meta = { resolved, slug, display };
}

/** Render a wikilink token as either an anchor or a missing-link span. */
function renderWikilinkToken(token: Token): string {
  const meta = token.meta as { resolved: PageId | null; slug: string; display: string };
  const display = escapeHtml(meta.display || meta.slug);
  if (!meta.resolved) {
    return `<span data-missing="true">[[${display}]]</span>`;
  }
  const href = `#/${encodeUriSegment(meta.resolved)}`;
  return `<a class="wikilink" data-page-id="${escapeHtml(meta.resolved)}" href="${escapeHtml(href)}">${display}</a>`;
}

/** Encode a `concepts/<slug>` PageId into the URI form used by the hash router. */
function encodeUriSegment(id: PageId): string {
  const [directory, slug] = id.split("/");
  return `${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`;
}
