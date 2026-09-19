/**
 * Shared production consumption of source-citation markers in Markdown.
 * A citation owns everything through its first closing bracket, including any
 * nested-looking wikilink text. Reporting must honor that same boundary; the
 * viewer supplies its existing chip emitter without sharing rendering context.
 */
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { extractClaimCitations } from "../utils/markdown.js";
import { shouldDeferInlineRule } from "../viewer/markdown-it-helpers.js";
import type { ClaimCitation } from "../utils/types.js";

const CHAR_CARET = 0x5e;
const CHAR_OPEN_BRACKET = 0x5b;

/** Register recognition after links; an optional emitter decorates viewer chips. */
export function registerCitationTokens(
  md: MarkdownIt,
  emit?: (state: StateInline, citations: ClaimCitation[]) => void,
): void {
  md.inline.ruler.after("link", "citation", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== CHAR_CARET) return false;
    if (state.src.charCodeAt(state.pos + 1) !== CHAR_OPEN_BRACKET) return false;
    if (shouldDeferInlineRule(state, silent)) return false;
    const closeAt = state.src.indexOf("]", state.pos + 2);
    if (closeAt < 0) return false;
    const inner = state.src.slice(state.pos + 2, closeAt);
    if (inner.includes("\n")) return false;
    emit?.(state, extractClaimCitations(`^[${inner}]`));
    state.pos = closeAt + 1;
    return true;
  });
}
