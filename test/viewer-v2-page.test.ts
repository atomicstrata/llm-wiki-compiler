/**
 * The v2 viewer's page view, rendered to static markup against fixture
 * payloads: the heading rules of the original client, the support rail's
 * sections, and the pure derivations behind them.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EntityContext, GraphData, PagePayload, PagesEnvelope } from "../viewer-v2/src/api.js";
import { backlinksFrom, connectorHref, groupCitationsByFile, groupRelations, pageKind, stripLeadingHeading } from "../viewer-v2/src/page-model.js";
import { PageRail } from "../viewer-v2/src/page-rail.js";
import { PageBody, PageHeader } from "../viewer-v2/src/page-view.js";
import type { AsyncState } from "../viewer-v2/src/use-async.js";
import { envelope, graph, page, pagePayload, text } from "./fixtures/viewer-v2-fixtures.js";

const WIKI = envelope({ sourceFilenames: ["notes.md"], pages: [page({ id: "concepts/beta" }), page({ id: "concepts/alpha" })] });

const CITED_SPAN = { file: "notes.md", lines: { start: 12, end: 15 } };
const PAGE = pagePayload({
  citations: [{ raw: "notes.md:12-15", spans: [CITED_SPAN] }, { raw: "notes.md:12-15", spans: [CITED_SPAN, { file: "gone.md" }] }],
  warnings: [{ code: "unresolved_citation", message: "Source not found: gone.md" }],
  outgoingLinks: ["concepts/beta"],
  freshness: { freshnessStatus: "stale", contradicted: true, archived: false },
  frontmatter: { kind: "concept" },
});

const GRAPH = graph(["concepts/alpha", "concepts/beta", "concepts/gamma"], [
  { source: "concepts/alpha", target: "concepts/beta" },
  { source: "concepts/gamma", target: "concepts/alpha" },
  { source: "concepts/gamma", target: "concepts/alpha" },
  { source: "concepts/beta", target: "concepts/alpha", edgeKind: "relation", relationType: "cites" },
]);

const ENTITY_CONTEXT: EntityContext = {
  relations: [
    { type: "cites", direction: "outgoing", target: { id: "papers/p2", resolved: true, title: "Paper two" } },
    { type: "cites", direction: "incoming", target: { id: "papers/p3", resolved: false } },
    { type: "cites", direction: "outgoing", target: { id: "papers/p4", resolved: true, title: "Paper four" } },
  ],
  relationTotal: 3,
  sources: [{ file: "notes.md", lines: { start: 1, end: 2 }, resolved: true }],
  sourceTotal: 1,
  connector: { connectorId: "crossref", connectorVersion: "1", fetchedAt: "2026-11-01T10:00:00Z", contentHash: "abc", sourceUrl: "https://api.example.org/works/1" },
};

/** The rail for `payload` with the graph in `graphState`. */
function rail(payload: PagePayload, graphState: AsyncState<GraphData>, wiki: PagesEnvelope = WIKI): string {
  return renderToStaticMarkup(createElement(PageRail, { page: payload, wiki, graph: graphState }));
}

describe("PageHeader and PageBody", () => {
  it("falls back to the slug, asks the question of a query, and shows each warning", () => {
    const query = pagePayload({
      id: "queries/why-cone-6",
      title: "",
      warnings: [{ code: "missing_title", message: "" }, { code: "unresolved_citation", message: "Source not found: gone.md" }],
    });
    const html = renderToStaticMarkup(createElement(PageHeader, { page: query }));
    expect(html).toMatch(/<h1[^>]*>why-cone-6<\/h1>/);
    expect(html).toContain("Question: why-cone-6");
    expect(html).toMatch(/data-code="missing_title"[^>]*>missing_title</);
    expect(html).toContain("Source not found: gone.md");
  });

  it("drops a leading heading that repeats the title and notes an empty body", () => {
    expect(stripLeadingHeading("<h1>Alpha</h1>\n<p>x</p>", "Alpha")).toBe("<p>x</p>");
    expect(stripLeadingHeading('<h1 id="a">Tom &amp; <em>Jerry</em></h1><p>x</p>', " Tom & Jerry ")).toBe("<p>x</p>");
    expect(stripLeadingHeading("<h1>Other</h1><p>x</p>", "Alpha")).toBe("<h1>Other</h1><p>x</p>");
    expect(stripLeadingHeading("<p>y</p><h1>Alpha</h1>", "Alpha")).toBe("<p>y</p><h1>Alpha</h1>");
    expect(renderToStaticMarkup(createElement(PageBody, { page: pagePayload({ html: "" }) }))).toContain("No rendered content.");
  });
});

describe("PageRail", () => {
  it("shows metadata with the list's freshness dot and the list row's counts", () => {
    const html = rail(PAGE, { status: "ready", data: GRAPH });
    const shown = text(html);
    expect(shown).toContain("Kind concept Freshness stale · contradicted");
    expect(shown).toContain("Created 2026-11-10 12:00 Updated 2026-11-10 12:00");
    expect(shown).toContain("Citations 2 Unresolved 1");
  });

  it("links each cited span once, marks the missing file, and lists links out and backlinks by title", () => {
    const html = rail(PAGE, { status: "ready", data: GRAPH });
    expect(html.match(/notes\.md:12-15/g)?.length).toBe(1);
    expect(html).toContain('href="#/_source/notes.md?start=12&amp;end=15"');
    expect(html).toMatch(/data-file="gone.md".*data-resolved="false"[^>]*>whole file · not found</);
    expect(text(html)).toContain("Links out Beta Backlinks Beta Gamma");
    expect(html).toMatch(/href="#\/concepts\/gamma"[^>]*>Gamma</);
  });

  it("says when nothing is cited or linked, and waits for the graph", () => {
    const lonely = pagePayload({ id: "concepts/zeta" });
    const ready = rail(lonely, { status: "ready", data: GRAPH });
    expect(ready).toContain("No citations.");
    expect(ready).toContain("No outgoing links.");
    expect(ready).toContain("No backlinks.");
    expect(rail(lonely, { status: "loading" })).toContain("Loading…");
    expect(rail(lonely, { status: "error", message: "Graph unavailable" })).toContain("Graph unavailable");
  });

  it("groups a typed page's relations by type and direction and shows the connector", () => {
    const typed = pagePayload({ id: "papers/p1", entityType: "papers", entityContext: ENTITY_CONTEXT });
    const html = rail(typed, { status: "loading" });
    const shown = text(html);
    expect(shown).toContain("Cites outgoing Paper two Paper four Cites incoming papers/p3 not found");
    expect(html).toMatch(/<li title="cites · outgoing · papers\/p2"><a href="#\/papers\/p2" data-page-id="papers\/p2"[^>]*>Paper two<\/a><\/li>/);
    expect(html).toContain('href="#/_source/notes.md?start=1&amp;end=2"');
    expect(html).toContain("Imported from Crossref on 2026-11-01 10:00.");
    expect(html).toContain('href="https://api.example.org/works/1"');
    expect(rail(PAGE, { status: "loading" })).not.toContain("Connected records");
  });
});

describe("page model", () => {
  it("derives the kind the list rows show", () => {
    expect(pageKind(pagePayload({ frontmatter: { type: "query" } }))).toBe("query");
    expect(pageKind(pagePayload({ entityType: "papers" }))).toBe("papers");
    expect(pageKind(pagePayload())).toBe("concept");
  });

  it("groups citations by file, backlinks by source, and relations by type and direction", () => {
    const groups = groupCitationsByFile(PAGE.citations, ["notes.md"]);
    expect(groups.map((group) => `${group.file}:${group.resolved}:${group.spans.length}`)).toEqual(["notes.md:true:1", "gone.md:false:1"]);
    expect(backlinksFrom(GRAPH, "concepts/alpha").map((link) => link.id)).toEqual(["concepts/beta", "concepts/gamma"]);
    expect(backlinksFrom(GRAPH, "concepts/gamma")).toEqual([]);
    const relations = groupRelations(ENTITY_CONTEXT.relations);
    expect(relations.map((group) => `${group.type}:${group.direction}:${group.relations.length}`)).toEqual(["cites:outgoing:2", "cites:incoming:1"]);
  });

  it("opens only credential-free web connector links", () => {
    expect(connectorHref("https://example.org/x")).toBe("https://example.org/x");
    expect(connectorHref("https://user:pw@example.org/x")).toBeNull();
    expect(connectorHref("ftp://example.org/x")).toBeNull();
    expect(connectorHref("not a url")).toBeNull();
    expect(connectorHref(undefined)).toBeNull();
  });
});
