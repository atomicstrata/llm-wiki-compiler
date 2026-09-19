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
import type Token from "markdown-it/lib/token.mjs";
import { resolveBareSlug } from "./collect.js";
import { registerWikilinkTokens } from "../wiki/wikilink-tokens.js";
import { escapeHtml } from "./markdown-it-helpers.js";
import type { PageId, ViewerPage } from "./types.js";

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
  registerWikilinkTokens(md);
  md.core.ruler.after("inline", "resolve_wikilinks", (state) => {
    resolveWikilinkTokens(state.tokens, context);
  });
  md.renderer.rules.wikilink = (tokens: Token[], idx: number): string =>
    renderWikilinkToken(tokens[idx]);
}

/** Add snapshot resolution after recognition, preserving parsed-token metadata. */
function resolveWikilinkTokens(tokens: Token[], context: WikilinkContext): void {
  for (const token of tokens) {
    if (token.type === "wikilink") {
      token.meta.resolved = resolveBareSlug(token.meta.slug, context.pages);
    }
    if (token.children) resolveWikilinkTokens(token.children, context);
  }
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
