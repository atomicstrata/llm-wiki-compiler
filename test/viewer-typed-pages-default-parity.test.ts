/**
 * @file test/viewer-typed-pages-default-parity.test.ts
 * @description The DEFAULT profile must not move when typed entity pages reach
 * the viewer's page surfaces.
 *
 * `collectEntityPages` throws on the built-in default by design, so the typed
 * page path is gated off entirely for a default project. That gate is only
 * worth as much as a test that pins the result, so the goldens below were
 * captured from the build IMMEDIATELY BEFORE the typed-page slice and are
 * compared field-for-field: the `/api/pages` envelope (including its top-level
 * key ORDER, which byte-identity depends on), the `/api/page/:dir/:slug`
 * payload, and `/api/search`. Any additive field leaking onto the default path
 * — an `entityType` key, an extra envelope entry — fails here.
 *
 * Volatile-by-construction fields are normalised away, never the shape:
 * `project` (temp-dir basename), `updatedAt`/`generatedAt` (wall clock), and
 * the page `html` (whose loopback citation chip embeds the absolute temp root).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { startViewerServer } from "../src/viewer/server.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

/** Envelope top-level keys, in the order the pre-change server emitted them. */
const ENVELOPE_KEYS = [
  "project",
  "stateStatus",
  "profileId",
  "counts",
  "graph",
  "sourceFilenames",
  "index",
  "recentPages",
  "pages",
  "updatedAt",
];

const FRESH_UNVERIFIED = { freshnessStatus: "unverified", contradicted: false, archived: false };

/** The `/api/pages` envelope the pre-change build produced for {@link seedDefaultProject}. */
const GOLDEN_ENVELOPE = {
  stateStatus: "missing",
  profileId: "default",
  counts: {
    concepts: 1,
    queries: 1,
    sourceFiles: 1,
    pendingReviews: 0,
    compiledSources: 0,
    stale: 0,
    orphaned: 0,
  },
  graph: { nodeCount: 2, edgeCount: 1, danglingCount: 0 },
  sourceFilenames: ["s.md"],
  index: { available: false, href: "/#/index" },
  recentPages: [
    { id: "queries/beta", pageDirectory: "queries", slug: "beta", title: "Beta", updatedAt: "2026-01-03T00:00:00.000Z" },
    { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha", updatedAt: "2026-01-02T00:00:00.000Z" },
  ],
  pages: [
    {
      id: "concepts/alpha",
      pageDirectory: "concepts",
      slug: "alpha",
      title: "Alpha",
      kind: "concept",
      summary: "The alpha concept.",
      updatedAt: "2026-01-02T00:00:00.000Z",
      warnings: [],
      freshness: FRESH_UNVERIFIED,
      citationCount: 1,
      unresolvedCitationCount: 0,
    },
    {
      id: "queries/beta",
      pageDirectory: "queries",
      slug: "beta",
      title: "Beta",
      kind: "query",
      summary: "The beta query.",
      updatedAt: "2026-01-03T00:00:00.000Z",
      warnings: [],
      freshness: FRESH_UNVERIFIED,
      citationCount: 0,
      unresolvedCitationCount: 0,
    },
  ],
};

/** The `/api/page/concepts/alpha` payload the pre-change build produced, minus `html`. */
const GOLDEN_PAGE = {
  id: "concepts/alpha",
  title: "Alpha",
  pageDirectory: "concepts",
  slug: "alpha",
  citations: [{ raw: "s.md:1-2", spans: [{ file: "s.md", lines: { start: 1, end: 2 } }] }],
  outgoingLinks: ["queries/beta"],
  frontmatter: {
    title: "Alpha",
    kind: "concept",
    summary: "The alpha concept.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  warnings: [],
  freshness: FRESH_UNVERIFIED,
  updatedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** The `/api/search?q=alpha` envelope the pre-change build produced. */
const GOLDEN_SEARCH = {
  results: [
    { id: "concepts/alpha", pageDirectory: "concepts", title: "Alpha", snippet: "Alpha", matchedIn: "title" },
  ],
};

const handles: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
});

/** The fixed default-profile project the goldens above were captured against. */
async function seedDefaultProject(): Promise<string> {
  const root = await makeTempRoot("viewer-default-parity");
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, "wiki/concepts/alpha.md"),
    '---\ntitle: Alpha\nkind: concept\nsummary: The alpha concept.\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-02T00:00:00.000Z"\n---\nAlpha links to [[Beta]] and cites a source.^[s.md:1-2]\n',
  );
  await writeFile(
    path.join(root, "wiki/queries/beta.md"),
    '---\ntitle: Beta\ntype: query\nsummary: The beta query.\ncreatedAt: "2026-01-03T00:00:00.000Z"\n---\nBeta answers a question.\n',
  );
  await writeFile(path.join(root, "sources/s.md"), "Source text line one.\nLine two.\n");
  return root;
}

/** Boot an in-process viewer over the fixed default project. */
async function startDefaultViewer(): Promise<string> {
  const handle = await startViewerServer(await buildViewerSnapshot(await seedDefaultProject()), {
    host: "127.0.0.1",
    port: 0,
  });
  handles.push(handle);
  return `http://${handle.host}:${handle.port}`;
}

/** GET `pathname` from a fresh default viewer and parse its JSON body. */
async function getJson(pathname: string): Promise<Record<string, unknown>> {
  const url = await startDefaultViewer();
  return (await (await fetch(`${url}${pathname}`)).json()) as Record<string, unknown>;
}

describe("default-profile parity — /api/pages", () => {
  it("emits the same top-level keys, in the same order", async () => {
    expect(Object.keys(await getJson("/api/pages"))).toEqual(ENVELOPE_KEYS);
  });

  it("emits the pre-change envelope field for field", async () => {
    const env = await getJson("/api/pages");
    delete env.project;
    delete env.updatedAt;
    expect(env).toEqual(GOLDEN_ENVELOPE);
  });
});

describe("default-profile parity — page route and search", () => {
  it("emits the pre-change page payload field for field", async () => {
    const page = await getJson("/api/page/concepts/alpha");
    expect(Object.keys(page)).toContain("html");
    delete page.html;
    delete page.generatedAt;
    expect(page).toEqual(GOLDEN_PAGE);
  });

  it("emits the pre-change search envelope field for field", async () => {
    expect(await getJson("/api/search?q=alpha")).toEqual(GOLDEN_SEARCH);
  });

  it("still rejects a typed directory when no profile declares one", async () => {
    const url = await startDefaultViewer();
    const res = await fetch(`${url}/api/page/articles/alpha`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });
});
