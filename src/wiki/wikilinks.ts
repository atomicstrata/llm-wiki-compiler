/**
 * @file src/wiki/wikilinks.ts
 * @description The single reader of `[[target]]` / `[[target|label]]` links in a
 * page body. A link exists exactly when the renderer (the viewer and answer
 * reporting) recognizes one, so text in code, escaped brackets, link text and
 * destinations, autolinks and reference definitions is not a link. Lint, lint
 * fix plans, the link graph, schema link counts, the `rm` plan, link repair
 * and OKF export all read links here, so they agree about which links exist.
 */

import { locateWikilinks } from "./wikilink-locate.js";

/** One live wikilink occurrence. */
export interface WikilinkMatch {
  /** Everything between the brackets, as written (`target` or `target|label`). */
  inner: string;
  /** The link target as the renderer reads it, trimmed, before any `|`. */
  target: string;
  /** The display label after `|`, trimmed, when present. */
  label?: string;
  /** Offset of the opening `[[` in the scanned text. */
  index: number;
  /** One-based line of the opening `[[`. */
  line: number;
}

/** The brackets around a link's inner text. */
const BRACKETS_LENGTH = "[[]]".length;

/**
 * Every wikilink in `text` that Markdown renders as a link, in order. The text
 * is parsed only when it contains `[[`, so pages without links cost a
 * substring search.
 */
export function findWikilinks(text: string): WikilinkMatch[] {
  if (!text.includes("[[")) return [];
  const lineStarts = lineStartOffsets(text);
  return locateWikilinks(text).map(({ start, end, inner: parsed }) => {
    const bar = parsed.indexOf("|");
    const target = (bar < 0 ? parsed : parsed.slice(0, bar)).trim();
    const label = bar < 0 ? undefined : parsed.slice(bar + 1).trim();
    return { inner: text.slice(start + 2, end - 2), target, label, index: start, line: lineOf(lineStarts, start) };
  });
}

/**
 * Replace each live wikilink with `rewrite(link)`, leaving it verbatim when that
 * returns undefined. Text that is not a link is never touched.
 */
export function rewriteWikilinks(text: string, rewrite: (link: WikilinkMatch) => string | undefined): string {
  let result = "";
  let copiedUpTo = 0;
  for (const link of findWikilinks(text)) {
    const replacement = rewrite(link);
    if (replacement === undefined) continue;
    result += text.slice(copiedUpTo, link.index) + replacement;
    copiedUpTo = link.index + link.inner.length + BRACKETS_LENGTH;
  }
  return result + text.slice(copiedUpTo);
}

/** Offsets at which each line begins. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\n/g)) starts.push(match.index + 1);
  return starts;
}

/** One-based line containing `offset`, by binary search over line starts. */
function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
