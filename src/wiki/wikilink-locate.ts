/**
 * @file src/wiki/wikilink-locate.ts
 * @description Page-byte offsets of the wikilinks the renderer recognizes.
 *
 * Which `[[...]]` text is a link is decided by the production recognizer
 * (`createWikilinkRecognizer`), the parser the viewer and answer reporting use.
 * Escapes, code, link text and destinations, autolinks and reference
 * definitions therefore follow Markdown exactly instead of a hand-kept copy of
 * its rules. markdown-it reports inline content rather than byte offsets, so
 * each recognized link is mapped back to the page:
 *
 * - A block's inline content is its source text with characters removed:
 *   container markers and indentation, heading markers, table pipes and the
 *   backslash of an escaped pipe, line endings and surrounding whitespace.
 *   None of those is a bracket.
 * - Matching the content's non-whitespace characters, in order and leftmost
 *   first, against the block's own lines (a table row cell by cell) therefore
 *   places every `[` and `]` exactly: a leftmost match can land early only on a
 *   removed character, and a removed character is never a bracket.
 * - An image's alt text is parsed as a separate string starting two characters
 *   after its `![`, so its offsets are shifted into the enclosing content first.
 */

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { createWikilinkRecognizer } from "./wikilink-tokens.js";

/** One recognized wikilink: its page-byte range and its text as the renderer read it. */
export interface LocatedWikilink {
  /** Offset of the opening `[[`. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
  /** The text between the brackets as parsed (in a table cell, `\|` reads as `|`). */
  inner: string;
}

/** Per-parse bookkeeping: where each inline parse's source starts in its block's content. */
interface LocateEnv {
  bases: Map<Token[], number>;
  active: StateInline[];
}

/** The shortest bracketed range: an empty link. */
const EMPTY_LINK = "[[]]";
/** An image's alt text starts after its `![`. */
const ALT_TEXT_OFFSET = 2;
/** markdown-it's line breaks: CRLF, a lone CR and LF each end a line. */
const LINE_BREAK = /\r\n?|\n/g;
/** markdown-it replaces NUL with U+FFFD in the content it parses. */
const NUL = "\0";
const REPLACEMENT_CHARACTER = "�";

/** Each recognized token's offsets in its own parse's source. */
const parsedRanges = new WeakMap<Token, LocatedWikilink>();
const recognizer = createWikilinkRecognizer((token, state, start, end) => {
  parsedRanges.set(token, { start, end, inner: state.src.slice(start + 2, end - 2) });
});
const tokenize = recognizer.inline.tokenize.bind(recognizer.inline);
// Record each inline parse's starting offset. Link text reuses its parent's
// state, so only image alt text (a new source string) needs a shifted base.
recognizer.inline.tokenize = (state: StateInline): void => {
  const env = state.env as LocateEnv;
  const parent = env.active.at(-1);
  if (!env.bases.has(state.tokens)) {
    env.bases.set(state.tokens, parent ? env.bases.get(parent.tokens)! + parent.pos + ALT_TEXT_OFFSET : 0);
  }
  env.active.push(state);
  try {
    tokenize(state);
  } finally {
    env.active.pop();
  }
};

/** Every wikilink the renderer recognizes in `body`, with its page offsets, in document order. */
export function locateWikilinks(body: string): LocatedWikilink[] {
  const env: LocateEnv = { bases: new Map(), active: [] };
  const lineStarts = [0, ...[...body.matchAll(LINE_BREAK)].map(match => match.index + match[0].length)];
  const located: LocatedWikilink[] = [];
  let cursor = 0;
  for (const token of recognizer.parse(body, env)) {
    // A block restarts alignment at its first line; table cells carry no map
    // and continue along their row.
    if (token.map && (token.type === "inline" || token.type === "tr_open")) cursor = lineStarts[token.map[0]];
    if (token.type !== "inline") continue;
    const positions = alignContent(body, token.content, cursor);
    cursor = positions.next;
    for (const link of contentLinks(token.children ?? [], env.bases)) {
      const start = positions.at[link.start];
      const end = positions.at[link.end - 1] + 1;
      if (isBracketed(body, start, end)) located.push({ start, end, inner: link.inner });
    }
  }
  return located;
}

/**
 * Whether the aligned range really opens with `[[` and closes with `]]`. The
 * alignment argument above guarantees it; the check keeps a parser change that
 * broke that argument from rewriting the wrong bytes.
 */
function isBracketed(body: string, start: number, end: number): boolean {
  return start >= 0 && end - start >= EMPTY_LINK.length && body.startsWith("[[", start) && body.startsWith("]]", end - 2);
}

/** Recognized links in one block, as offsets into its content, including those in image alt text. */
function contentLinks(children: Token[], bases: Map<Token[], number>): LocatedWikilink[] {
  const base = bases.get(children) ?? 0;
  const links: LocatedWikilink[] = [];
  for (const child of children) {
    const parsed = parsedRanges.get(child);
    if (parsed) links.push({ start: base + parsed.start, end: base + parsed.end, inner: parsed.inner });
    if (child.children) links.push(...contentLinks(child.children, bases));
  }
  return links;
}

/**
 * Page offset of each non-whitespace content character (-1 for whitespace),
 * matched leftmost-first from `from`, and the offset after the last match.
 */
function alignContent(body: string, content: string, from: number): { at: number[]; next: number } {
  const at: number[] = [];
  let next = from;
  // By UTF-16 unit, the unit markdown-it's offsets count in.
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (/\s/.test(char)) {
      at.push(-1);
      continue;
    }
    const found = char === REPLACEMENT_CHARACTER ? firstOf(body, [char, NUL], next) : body.indexOf(char, next);
    at.push(found);
    if (found >= 0) next = found + 1;
  }
  return { at, next };
}

/** The earliest offset at or after `from` holding any of `chars`, or -1. */
function firstOf(body: string, chars: string[], from: number): number {
  const hits = chars.map(char => body.indexOf(char, from)).filter(hit => hit >= 0);
  return hits.length > 0 ? Math.min(...hits) : -1;
}
