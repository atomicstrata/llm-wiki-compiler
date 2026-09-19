/**
 * Shared wikilink recognition contract for answer reporting and the viewer.
 * Pins the existing viewer's edge cases independently, then compares parsed
 * token metadata and exact HTML so extracting recognition cannot alter links.
 */
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { describe, expect, it } from "vitest";
import { registerWikilink } from "../src/viewer/wikilink-rule.js";
import type { ViewerPage } from "../src/viewer/types.js";
import * as shared from "../src/wiki/wikilink-tokens.js";

/** Flatten parsed tokens, including nested image/inline children. */
function wikilinks(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => [
    ...(token.type === "wikilink" ? [token] : []),
    ...wikilinks(token.children ?? []),
  ]);
}

/** Match the viewer's production Markdown options. */
function markdown(): MarkdownIt {
  return new MarkdownIt({ html: false, linkify: false, breaks: false });
}

const edgeCases: [string, { slug: string; display: string }[]][] = [
  ["[[[alpha]]]", [{ slug: "alpha", display: "alpha" }]],
  ["[[outer [[alpha]] tail]]", [{ slug: "alpha", display: "alpha" }]],
  ["[[alpha[beta]]", []],
  ["> ~~~\n> [[alpha]]\n> ~~~", []],
  ["> ```md\n> [[alpha]]\n> ```", []],
  ["    [[alpha]]", []],
  ["[[]]", [{ slug: "", display: "" }]],
  ["[[ |label]]", [{ slug: "", display: "label" }]],
  ["[[東京 Café|日本語]]", [{ slug: "東京-café", display: "日本語" }]],
  ["[[ALPHA| ]]", [{ slug: "alpha", display: "ALPHA" }]],
];

describe("existing viewer recognition", () => {
  it.each(edgeCases)("preserves parsed tokens for %s", (body, expected) => {
    const viewer = markdown();
    registerWikilink(viewer, { pages: [] });
    expect(wikilinks(viewer.parse(body, {})).map((token) => token.meta)).toEqual(
      expected.map((meta) => ({ ...meta, resolved: null })),
    );
  });
});

describe("shared wikilink tokens", () => {
  it("exports both production recognition APIs", () => {
    expect(shared.registerWikilinkTokens).toBeTypeOf("function");
    expect(shared.recognizedWikilinkTargets).toBeTypeOf("function");
  });

  it.each([
    ["[[Alpha|label]]", ["alpha"]],
    ["`[[alpha]]`", []],
    ["```md\n[[alpha]]\n```", []],
    ["~~~\n[[alpha]]\n~~~", []],
    ["\\[[alpha]]", []],
    ["[See [[alpha]]](https://example.com)", []],
    ["[[alpha\nbeta]]", []],
    ["[[alpha]] [[alpha]]", ["alpha", "alpha"]],
    ["# [[Beta]]\n\n> [[Alpha]]\n\n- [[Beta|again]]", ["beta", "alpha", "beta"]],
    ["![[[Alpha]]](image.png)", ["alpha"]],
    ["", []],
  ])("recognizes %s", (body, expected) => {
    expect(shared.recognizedWikilinkTargets(body as string)).toEqual(expected);
  });

  it.each(edgeCases)("matches viewer metadata for %s", (body, expected) => {
    const parser = markdown();
    shared.registerWikilinkTokens(parser);
    const viewer = markdown();
    registerWikilink(viewer, { pages: [] });
    const tokens = wikilinks(parser.parse(body, {}));
    expect(tokens.map((token) => token.meta)).toEqual(expected);
    expect(tokens.map((token) => ({ ...token.meta, resolved: null }))).toEqual(
      wikilinks(viewer.parse(body, {})).map((token) => token.meta),
    );
    expect(shared.recognizedWikilinkTargets(body)).toEqual(expected.map(({ slug }) => slug));
  });

  it("retains viewer resolution metadata and exact escaped HTML", () => {
    const page: ViewerPage = {
      id: "concepts/alpha", slug: "alpha", title: "Alpha", pageDirectory: "concepts",
      filePath: "/tmp/alpha.md", frontmatter: {}, body: "", outgoingLinks: [],
      citations: [], warnings: [], aliases: ["first"],
      freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
    };
    const viewer = markdown();
    registerWikilink(viewer, { pages: [page] });
    const body = '[[first|A & <B>]] [[ghost|"missing"]]';
    expect(wikilinks(viewer.parse(body, {})).map((token) => token.meta)).toEqual([
      { slug: "first", display: "A & <B>", resolved: "concepts/alpha" },
      { slug: "ghost", display: '"missing"', resolved: null },
    ]);
    expect(viewer.render(body)).toBe(
      '<p><a class="wikilink" data-page-id="concepts/alpha" href="#/concepts/alpha">A &amp; &lt;B&gt;</a> '
      + '<span data-missing="true">[[&quot;missing&quot;]]</span></p>\n',
    );
  });
});
