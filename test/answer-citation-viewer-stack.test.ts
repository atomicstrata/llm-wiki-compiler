/**
 * Full viewer-stack parity witnesses include source-citation parsing and HTML
 * sanitization, which a bare wikilink-only markdown-it instance cannot cover.
 */
import { expect, it } from "vitest";
import { renderPageHtml } from "../src/viewer/render.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";
import { recognizedWikilinkTargets } from "../src/wiki/wikilink-tokens.js";

const snapshot: ViewerSnapshot = {
  root: "/tmp/wiki", generatedAt: "2026-09-18T00:00:00Z",
  project: { title: "Test", rootName: "test" }, stateStatus: "missing",
  counts: { concepts: 0, queries: 0, sourceFiles: 1, pendingReviews: 0, compiledSources: 0, stale: 0, orphaned: 0 },
  index: { available: false, href: "/#/index", body: "", outgoingLinks: [] },
  recentPages: [], pages: [], sourceFilenames: ["source.md"],
  graph: { nodes: [], edges: [] },
};

it.each([
  ["^[source.md:1-2] [[Alpha]] ^[source.md] [[Beta]]", ["alpha", "beta"]],
  ["^[source.md] `[[code]]` [See [[link]]](https://example.com) [[Alpha]]", ["alpha"]],
  ["^[source.md [[Alpha]]] [[Beta]]", ["beta"]],
  ["\\^[source.md [[Alpha]]] [[Beta]]", ["alpha", "beta"]],
  ["`^[source.md [[Alpha]]]` [[Beta]]", ["beta"]],
  ["~~~\n^[source.md [[Alpha]]]\n~~~\n[[Beta]]", ["beta"]],
])("matches full viewer recognition for mixed source citations: %s", (body, expected) => {
  const { html } = renderPageHtml(body as string, snapshot, { isLoopback: false });
  const renderedTargets = [...html.matchAll(/data-missing="true">\[\[([^<]+)\]\]<\/span>/g)]
    .map((match) => match[1].toLowerCase());
  expect(renderedTargets).toEqual(expected);
  expect(recognizedWikilinkTargets(body as string)).toEqual(expected);
});
