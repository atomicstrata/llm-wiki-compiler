/**
 * `GET /api/source/<id>/cited-by`: which pages cite a source file, and which
 * of its lines. The builder is tested on hand-made snapshot pages, and the
 * route through `handleApiSource` with a response stand-in, so no server or
 * disk is involved: the route reads only the in-memory snapshot.
 */
import { describe, expect, it } from "bun:test";
import type { ServerResponse } from "http";
import { handleApiSource } from "../src/viewer/api-sources.js";
import { citedBy } from "../src/viewer/cited-by.js";
import type { ViewerPage } from "../src/viewer/types.js";

/** A snapshot page with only the fields the builder reads. */
function viewerPage(id: string, title: string, spans: { file: string; lines?: { start: number; end: number } }[], entityType?: string): ViewerPage {
  const [pageDirectory, slug] = id.split("/");
  return { id, pageDirectory, slug, title, entityType, citations: spans.map((span) => ({ raw: span.file, spans: [span] })) } as unknown as ViewerPage;
}

const PAGES = [
  viewerPage("concepts/zeta", "Zeta", [{ file: "notes.md", lines: { start: 3, end: 5 } }, { file: "notes.md", lines: { start: 3, end: 5 } }, { file: "other.md" }]),
  viewerPage("concepts/alpha", "Alpha", [{ file: "notes.md" }, { file: "notes.md", lines: { start: 9, end: 9 } }]),
  viewerPage("concepts/beta", "Beta", [{ file: "other.md" }]),
  viewerPage("papers/p1", "Paper", [{ file: "notes.md", lines: { start: 1, end: 2 } }], "papers"),
];

/** A response that records what the handler wrote. */
function recorder(): { res: ServerResponse; sent: () => { status: number; body: unknown } } {
  let status = 0;
  let body = "";
  const res = { statusCode: 0, setHeader: () => undefined, end: (chunk: string) => { status = res.statusCode; body = chunk; } };
  return { res: res as unknown as ServerResponse, sent: () => ({ status, body: JSON.parse(body) }) };
}

describe("citedBy", () => {
  it("lists citing pages by title with their distinct spans, whole-file citations as null", () => {
    const payload = citedBy(PAGES, "notes.md");
    expect(payload.source).toBe("notes.md");
    expect(payload.pages.map((page) => page.title)).toEqual(["Alpha", "Paper", "Zeta"]);
    expect(payload.pages[0].spans).toEqual([null, { start: 9, end: 9 }]);
    expect(payload.pages[2].spans).toEqual([{ start: 3, end: 5 }]);
    expect(payload.pages[1]).toEqual({ id: "papers/p1", title: "Paper", spans: [{ start: 1, end: 2 }] });
  });

  it("returns no pages for a source nothing cites", () => {
    expect(citedBy(PAGES, "unused.md").pages).toEqual([]);
  });
});

describe("the cited-by route", () => {
  const snapshot = { root: "/nowhere", sourceFilenames: ["notes.md"], pages: PAGES };

  it("answers from the snapshot, on loopback or not", async () => {
    const { res, sent } = recorder();
    await handleApiSource(res, snapshot, `/api/source/${encodeURIComponent("notes.md")}/cited-by`, false);
    expect(sent().status).toBe(200);
    expect((sent().body as { pages: unknown[] }).pages).toHaveLength(3);
  });

  it("still rejects an unknown subroute", async () => {
    const { res, sent } = recorder();
    await handleApiSource(res, snapshot, "/api/source/notes.md/edit", true);
    expect(sent()).toMatchObject({ status: 400, body: { error: { code: "invalid_source_id" } } });
  });
});
