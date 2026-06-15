import { describe, it, expect } from "vitest";
import { wikilinksToOkf, okfLinksToWikilinks } from "../src/export/okf/mapping.js";

const resolve = (slug: string) =>
  slug === "rag" ? { dir: "concepts" as const, title: "RAG" } : null;
// resolveLink: linkPath ("concepts/rag") -> { slug, title } | null for known bundle docs.
const resolveLink = (linkPath: string) =>
  linkPath === "concepts/rag" ? { slug: "rag", title: "RAG" } : null;

describe("wikilink <-> OKF link rewrite", () => {
  it("forward: [[slug]] -> [Title](/dir/slug.md); leaves unresolved links", () => {
    expect(wikilinksToOkf("see [[rag]] and [[unknown]].", resolve))
      .toBe("see [RAG](/concepts/rag.md) and [[unknown]].");
  });
  it("forward: pipe display is preserved", () => {
    expect(wikilinksToOkf("[[rag|the method]]", resolve)).toBe("[the method](/concepts/rag.md)");
  });
  it("reverse round-trips: text==title -> [[slug]]; else [[slug|text]]", () => {
    expect(okfLinksToWikilinks("[RAG](/concepts/rag.md)", resolveLink)).toBe("[[rag]]");
    expect(okfLinksToWikilinks("[the method](/concepts/rag.md)", resolveLink)).toBe("[[rag|the method]]");
  });
  it("forward then reverse reproduces the original body", () => {
    const original = "see [[rag]] and [[rag|the method]].";
    expect(okfLinksToWikilinks(wikilinksToOkf(original, resolve), resolveLink)).toBe(original);
  });
  it("does not rewrite [[..]] inside fenced code blocks", () => {
    const body = "```\n[[rag]]\n```\nout [[rag]]";
    expect(wikilinksToOkf(body, resolve)).toBe("```\n[[rag]]\n```\nout [RAG](/concepts/rag.md)");
  });
});
