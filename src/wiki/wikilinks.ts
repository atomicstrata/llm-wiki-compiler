/**
 * @file src/wiki/wikilinks.ts
 * @description The single reader of `[[target]]` / `[[target|label]]` links in a
 * page body. Text inside literal Markdown (fenced, indented or inline code) is
 * not a link: link repair and publication approval already skip it, so every
 * other reader (lint, lint fix plans, the link graph, schema link counts, the
 * `rm` plan and OKF export) must agree with them about which links exist.
 */

import { isLiteralMarkdown } from "../compiler/link-repair-code.js";

/** One live wikilink occurrence. */
export interface WikilinkMatch {
  /** Everything between the brackets, as written (`target` or `target|label`). */
  inner: string;
  /** The link target, trimmed, before any `|`. */
  target: string;
  /** The display label after `|`, trimmed, when present. */
  label?: string;
  /** Offset of the opening `[[` in the scanned text. */
  index: number;
  /** One-based line of the opening `[[`. */
  line: number;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;

/**
 * Every wikilink in `text` that Markdown renders as a link, in order. The text
 * is parsed for literal regions only when it contains `[[`, so pages without
 * links cost a substring search.
 */
export function findWikilinks(text: string): WikilinkMatch[] {
  if (!text.includes("[[")) return [];
  const literal = isLiteralMarkdown(text);
  const lineStarts = lineStartOffsets(text);
  const links: WikilinkMatch[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    if (literal(match.index)) continue;
    const inner = match[1];
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label = bar < 0 ? undefined : inner.slice(bar + 1).trim();
    links.push({ inner, target, label, index: match.index, line: lineOf(lineStarts, match.index) });
  }
  return links;
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
