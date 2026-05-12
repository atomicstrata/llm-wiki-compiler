/**
 * Shared internal helpers for the viewer's markdown-it inline rules.
 *
 * Both `wikilink-rule.ts` and `citation-rule.ts` need the same two
 * concerns: a minimal HTML escape for their render output (the rules
 * emit raw HTML strings that the sanitizer later validates), and a safe
 * read of `state.linkLevel` (a runtime property markdown-it sets while
 * parsing inside link text but `@types/markdown-it` 14 does not expose
 * on `StateInline`).
 */

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

/**
 * Minimal HTML attribute/text escape. Used by inline-rule renderers
 * that emit attribute values or visible text inside the HTML string
 * they hand back to markdown-it. The downstream sanitizer enforces the
 * tag/attribute allowlist; this escape just prevents structural breaks
 * (closing the tag early, breaking an attribute quote).
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Read `state.linkLevel`, which markdown-it sets while parsing inside
 * link text but `@types/markdown-it` 14 does not surface on
 * `StateInline`. Falls back to 0 if the property is absent so the rule
 * still parses on older typings.
 */
function currentLinkLevel(state: StateInline): number {
  const lifted = state as unknown as { linkLevel?: number };
  return typeof lifted.linkLevel === "number" ? lifted.linkLevel : 0;
}

/**
 * True when a custom inline rule should decline to match at the current
 * state. Two reasons it might:
 *
 *   - `state.linkLevel > 0`: markdown-it is recursively parsing inline
 *     content inside link text. Custom rules that emit anchors or
 *     other interactive elements must not fire there, or the rendered
 *     HTML carries nested anchors (invalid + a focus-trap accessibility
 *     hazard).
 *   - `silent === true`: markdown-it's link-label scanner uses
 *     `skipToken` in silent mode to count nested `[`/`]` for bracket
 *     matching. Consuming a nested `[` while silent trips the
 *     `disableNested` guard inside the link rule and breaks otherwise-
 *     valid markdown links of the shape `[outer [[alpha]] text](url)`.
 */
export function shouldDeferInlineRule(state: StateInline, silent: boolean): boolean {
  if (currentLinkLevel(state) > 0) return true;
  if (silent) return true;
  return false;
}
