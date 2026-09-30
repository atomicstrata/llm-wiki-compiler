/**
 * @file test/wikilink-locate.test.ts
 * @description Located wikilinks must point at the exact bytes the renderer
 * reads as links, because link repair, lint fixes and OKF export rewrite those
 * bytes. The renderer is the instrument: every located link is rewritten to a
 * numbered marker and the result re-parsed. The renderer must then see exactly
 * the markers, in order. A located range on a code example, an escaped bracket
 * or anything else that is not a link would leave the original link in place,
 * and the marker would not register.
 */

import { describe, expect, it } from "vitest";
import { wikilinksToOkf } from "../src/export/okf/mapping.js";
import { findWikilinks, rewriteWikilinks } from "../src/wiki/wikilinks.js";
import { recognizedWikilinkTargets } from "../src/wiki/wikilink-tokens.js";

/** Bodies where a link's content offset differs from its page offset, or a non-link precedes a link. */
const BODIES: Record<string, string> = {
  "code and escape before the link": "`[[x]]` \\[[x]] [[x]] and [[x]]",
  "table with escaped pipes": "| a | b |\n| - | - |\n| `[[x]]\\|` [[x]] | [[a\\|b]] [[y]] |",
  "table without outer pipes": "a | b\n- | -\n[[x]] | `[[x]]` [[y]]",
  "blockquote and list markers": "> - item `[[x]]`\n>   [[x]] cont\n> > [[y]]",
  "tab indentation": "- a\n\t[[x]] tabbed\n\n1.\t[[y]]",
  "CRLF line endings": "line [[a]]\r\n\r\n`[[a]]` [[b]]\r\nmore [[c]]",
  "lone CR line endings": "one [[a]]\rtwo [[b]]\r\rthree [[c]]",
  "NUL characters": "nul \0 [[a]] and [[b\0c]]",
  "astral characters": "😀 [[a]] 😀😀 `[[a]]` [[b]]",
  "image alt text, nested": "![alt [[x]] `[[x]]`](i.png) then [[x]] ![b ![c [[y]]](d)](e)",
  "heading markers": "# T `[[x]]` [[x]] ##\n\nSetext [[y]]\n===\n\n## [[z]] #",
  "link text and destinations": "[a [[x]] b](u) [[x]] <https://e/[[x]]> [[x]](u) [[x]]",
  "reference definition": "[r]: https://e \"[[x]]\"\n[[x]] uses [r]",
  "code blocks around a link": "> ```\n> [[x]]\n> ```\n> [[x]]\n\n    [[x]]\n\n[[x]]",
  "table after a code block": "para\n\n```\n[[x]]\n```\n\n| [[y]] | b |\n| - | - |\n| c | [[z]] |",
};

describe("located wikilinks are the renderer's links", () => {
  it.each(Object.entries(BODIES))("rewrites exactly the renderer's links: %s", (_label, body) => {
    const count = findWikilinks(body).length;
    // PRECONDITION pinned: the body has links, and as many as the renderer sees.
    expect(count, "fixture has no links").toBeGreaterThan(0);
    expect(recognizedWikilinkTargets(body)).toHaveLength(count);
    let next = 0;
    const rewritten = rewriteWikilinks(body, () => `[[marker-${next++}]]`);
    expect(recognizedWikilinkTargets(rewritten)).toEqual(Array.from({ length: count }, (_, i) => `marker-${i}`));
  });

  it("leaves text verbatim when the rewrite declines", () => {
    const body = "Keep [[a]] and `[[b]]`.";
    expect(rewriteWikilinks(body, () => undefined)).toBe(body);
  });

  it("OKF export converts only the link, not the escaped or link-text copies", () => {
    const body = "\\[[doc]] [see [[doc]]](https://example.com) [[doc]]";
    const exported = wikilinksToOkf(body, (slug) => ({ title: slug, path: `concepts/${slug}.md` }));
    expect(exported).toBe("\\[[doc]] [see [[doc]]](https://example.com) [doc](/concepts/doc.md)");
  });
});
