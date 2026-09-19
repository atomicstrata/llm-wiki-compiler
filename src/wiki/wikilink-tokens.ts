/**
 * Shared production wikilink tokenization for the viewer and answer reporting.
 * Token recognition stays independent of page resolution and HTML rendering.
 * Registration follows markdown-it's link rule so link labels, escapes, and
 * code retain the viewer's existing literal-text behavior. Empty targets and
 * repeated occurrences are preserved; reporting owns any deduplication.
 */
import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { slugify } from "../utils/markdown.js";
import { shouldDeferInlineRule } from "../viewer/markdown-it-helpers.js";
import { registerCitationTokens } from "./citation-tokens.js";

const OPEN = "[";
const CHAR_OPEN_BRACKET = 0x5b; // "["

/** Register production wikilink recognition without resolution or rendering. */
export function registerWikilinkTokens(md: MarkdownIt): void {
  md.inline.ruler.after("link", "wikilink", parseWikilink);
}

/** Return normalized target occurrences in Markdown document order. */
export function recognizedWikilinkTargets(body: string): string[] {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  registerWikilinkTokens(md);
  registerCitationTokens(md);
  const targets: string[] = [];
  collectTargets(md.parse(body, {}), targets);
  return targets;
}

/** Collect recognized tokens, including those nested in inline/image children. */
function collectTargets(tokens: Token[], result: string[]): void {
  for (const token of tokens) {
    if (token.type === "wikilink") result.push(token.meta.slug);
    if (token.children) collectTargets(token.children, result);
  }
}

/** Recognize one wikilink using the viewer's existing Markdown exclusions. */
function parseWikilink(state: StateInline, silent: boolean): boolean {
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
  const token = state.push("wikilink", "", 0);
  token.meta = { slug, display };
  state.pos = closeAt + 2;
  return true;
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
