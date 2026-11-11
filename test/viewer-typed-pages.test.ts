/**
 * @file test/viewer-typed-pages.test.ts
 * @description PHASE 1 — a NON-DEFAULT profile's typed entity pages reach the
 * viewer's PAGE surfaces, not only the graph.
 *
 * Before this slice `collectTypedGraphInputs` collected content-carrying
 * `EntityPage`s and threw everything but the identity away, so a newsroom
 * project with articles on disk reported `pages: []` on `/api/pages`, could not
 * address a typed page at `/api/page/<dir>/<slug>`, and never surfaced one in
 * search. These tests pin the three surfaces, the SHARED profile-invalid
 * exclusion (so the page list and the graph describe one corpus), the
 * decoration a typed page genuinely gets, and the machine-local paths that must
 * never escape.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { startViewerServer } from "../src/viewer/server.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildNewsroomProject } from "./fixtures/newsroom-profile.js";
import { writeMarkdownPage } from "./fixtures/profile-fixtures.js";

/** One row of `/api/pages.pages`. */
interface PageRow {
  id: string;
  pageDirectory: string;
  slug: string;
  entityType?: string;
  kind: string;
  warnings: { code: string }[];
  freshness: { freshnessStatus: string };
  citationCount: number;
}

interface Envelope {
  counts: Record<string, number>;
  graph: { nodeCount: number };
  pages: PageRow[];
  profileProblems?: { kind: string; path?: string }[];
}

const handles: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
});

/**
 * A newsroom project with three profile-VALID typed pages (one per entity
 * type), one profile-INVALID article (no `stage`, a required enum), and one
 * article whose body carries a citation and a wikilink.
 */
async function seedNewsroom(): Promise<string> {
  const root = await makeTempRoot("viewer-typed-pages");
  await buildNewsroomProject(root);
  await writeMarkdownPage(root, "wiki/articles", "no-stage", "---\nheadline: No stage\n---\nBody.");
  await writeMarkdownPage(
    root,
    "wiki/articles",
    "ferry-cuts",
    "---\nheadline: Ferry cuts\nstage: edited\n---\nCuts confirmed.^[missing.md:1-2] See [[Nowhere]].",
  );
  return root;
}

/** Boot an in-process viewer over `root` and return its base URL. */
async function startViewer(root: string): Promise<string> {
  const handle = await startViewerServer(await buildViewerSnapshot(root), {
    host: "127.0.0.1",
    port: 0,
  });
  handles.push(handle);
  return `http://${handle.host}:${handle.port}`;
}

/** Boot a newsroom viewer and read its `/api/pages` envelope. */
async function newsroomEnvelope(): Promise<{ url: string; env: Envelope }> {
  const url = await startViewer(await seedNewsroom());
  return { url, env: (await (await fetch(`${url}/api/pages`)).json()) as Envelope };
}

describe("typed entity pages in the /api/pages envelope", () => {
  it("lists every profile-VALID typed page with its entity type and directory", async () => {
    const { env } = await newsroomEnvelope();
    const typed = env.pages.filter((p) => p.entityType !== undefined);
    expect(typed.map((p) => p.id).sort()).toEqual([
      "articles/ferry-cuts",
      "articles/port-strike-latest",
      "bylines/j-rivera",
      "desks/metro",
    ]);
    expect(typed.every((p) => p.pageDirectory === p.entityType)).toBe(true);
  });

  it("labels a typed page's kind with its entity type, not the concept default", async () => {
    const { env } = await newsroomEnvelope();
    const desk = env.pages.find((p) => p.id === "desks/metro");
    expect(desk).toMatchObject({ entityType: "desks", pageDirectory: "desks", kind: "desks" });
  });

  it("excludes a profile-INVALID typed page, agreeing with the graph's exclusion", async () => {
    const { url, env } = await newsroomEnvelope();
    expect(env.pages.some((p) => p.id === "articles/no-stage")).toBe(false);
    const graph = (await (await fetch(`${url}/api/graph`)).json()) as { nodes: { id: string }[] };
    expect(graph.nodes.some((n) => n.id === "articles/no-stage")).toBe(false);
    expect(env.profileProblems?.some((p) => p.kind === "field-violation")).toBe(true);
  });

  it("keeps counts.concepts and counts.queries scoped to the default wiki dirs", async () => {
    const { env } = await newsroomEnvelope();
    expect(env.counts.concepts).toBe(0);
    expect(env.counts.queries).toBe(0);
  });

  it("does not double-count a typed page as both a page node and an entity node", async () => {
    const { url, env } = await newsroomEnvelope();
    const graph = (await (await fetch(`${url}/api/graph`)).json()) as { nodes: { id: string }[] };
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(env.graph.nodeCount).toBe(ids.length);
  });
});

describe("/api/page/<entityType>/<slug>", () => {
  it("serves a typed page with rendered HTML, its entity type, and its citations", async () => {
    const { url } = await newsroomEnvelope();
    const res = await fetch(`${url}/api/page/articles/ferry-cuts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("articles/ferry-cuts");
    expect(body.entityType).toBe("articles");
    expect(body.pageDirectory).toBe("articles");
    expect(body.html).toContain("Cuts confirmed.");
    expect(body.citations).toHaveLength(1);
  });

  it("404s a DECLARED entity type that has no such page", async () => {
    const { url } = await newsroomEnvelope();
    const res = await fetch(`${url}/api/page/desks/no-such-desk`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("page_not_found");
  });

  it("still serves a default page unchanged on a profile project", async () => {
    const root = await seedNewsroom();
    await writeMarkdownPage(root, "wiki/concepts", "alpha", "---\ntitle: Alpha\n---\nAlpha body.");
    const url = await startViewer(root);
    const body = (await (await fetch(`${url}/api/page/concepts/alpha`)).json()) as PageRow;
    expect(body.id).toBe("concepts/alpha");
    expect(body.entityType).toBeUndefined();
  });
});

describe("typed page decoration", () => {
  it("degrades freshness to unverified rather than fabricating a status", async () => {
    const { env } = await newsroomEnvelope();
    const typed = env.pages.filter((p) => p.entityType !== undefined);
    expect(typed.every((p) => p.freshness.freshnessStatus === "unverified")).toBe(true);
  });

  it("carries the body's citations and its unresolved-citation warning", async () => {
    const { env } = await newsroomEnvelope();
    const ferry = env.pages.find((p) => p.id === "articles/ferry-cuts");
    expect(ferry?.citationCount).toBe(1);
    expect(ferry?.warnings.map((w) => w.code)).toEqual(["unresolved_citation"]);
  });

  it("emits no default-profile parse warning over a contract-valid typed page", async () => {
    const { env } = await newsroomEnvelope();
    // Newsroom pages declare `headline`/`name`/`reporter`, never `title`; a
    // missing_title warning here would report a contract they were never under.
    const desk = env.pages.find((p) => p.id === "desks/metro");
    expect(desk?.warnings).toEqual([]);
  });
});

describe("/api/search over typed pages", () => {
  it("finds a typed page by body text and tags the row with its entity type", async () => {
    const { url } = await newsroomEnvelope();
    const res = await fetch(`${url}/api/search?q=labor`);
    const { results } = (await res.json()) as { results: { id: string; entityType?: string }[] };
    expect(results.map((r) => r.id).sort()).toEqual(["bylines/j-rivera", "desks/metro"]);
    expect(results.every((r) => r.entityType !== undefined)).toBe(true);
  });

  it("never returns a profile-INVALID typed page", async () => {
    const { url } = await newsroomEnvelope();
    const res = await fetch(`${url}/api/search?q=Body`);
    const { results } = (await res.json()) as { results: { id: string }[] };
    expect(results.some((r) => r.id === "articles/no-stage")).toBe(false);
  });
});

describe("no machine-local path escapes a typed-page response", () => {
  it("keeps the absolute filePath out of the envelope, search, graph, and page payload", async () => {
    const root = await seedNewsroom();
    const url = await startViewer(root);
    for (const route of ["/api/pages", "/api/search?q=labor", "/api/graph"]) {
      expect(await (await fetch(`${url}${route}`)).text()).not.toContain(root);
    }
    const page = (await (await fetch(`${url}/api/page/desks/metro`)).json()) as Record<string, unknown>;
    expect(page).not.toHaveProperty("filePath");
    // `html` is excluded: on loopback a citation chip carries the documented
    // `data-absolute-path` editor affordance (spec §Support Rail).
    delete page.html;
    expect(JSON.stringify(page)).not.toContain(root);
  });
});
