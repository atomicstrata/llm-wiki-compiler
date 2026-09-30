/**
 * @file src/wiki/wikilink-insertion.ts
 * @description Whether writing a new wikilink into a page only turns some text
 * into a link.
 *
 * Interlink resolution wraps title mentions in `[[slug|Title]]`. A mention can
 * sit where a link cannot: inside a Markdown link's URL or text, an autolink,
 * an image's alt text, a reference definition, or code. Writing a link there
 * corrupts the page, for example by breaking a URL or destroying a reference
 * definition. Rather than list those places, the check asks the viewer's own
 * parser two things:
 *
 * - The renderer must read the inserted text as a link, at exactly the place
 *   it was written. An unused reference definition renders nothing, so a
 *   rendering comparison alone cannot see a link written into its URL.
 * - The page must render exactly as it would with the title written there as
 *   plain text, with every wikilink rendered as its display text, so the
 *   insertion changes nothing around it (image alt text, a reference
 *   definition's label turned into a link).
 */

import type Token from "markdown-it/lib/token.mjs";
import { locateWikilinks } from "./wikilink-locate.js";
import { createWikilinkRecognizer } from "./wikilink-tokens.js";

const renderer = createWikilinkRecognizer();
// A wikilink renders as its display text, so it compares equal to that text written plainly.
renderer.renderer.rules.wikilink = (tokens: Token[], index: number): string =>
  renderer.utils.escapeHtml(tokens[index].meta.display);

/**
 * True when replacing `text[range.start, range.end)` with `link` makes the
 * renderer read `link` as a link there, and renders the page exactly as
 * replacing it with `display` does, apart from the link itself.
 */
export function insertsOnlyALink(
  text: string,
  range: { start: number; end: number },
  link: string,
  display: string,
): boolean {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const next = before + link + after;
  const linkEnd = range.start + link.length;
  const isRecognized = locateWikilinks(next).some(found => found.start === range.start && found.end === linkEnd);
  return isRecognized && renderer.render(next) === renderer.render(before + display + after);
}
