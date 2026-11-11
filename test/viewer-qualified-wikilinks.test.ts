/**
 * Folder-qualified wikilinks in the viewer.
 *
 * A link whose target is `dir/slug` (`[[papers/scaling-laws|Scaling]]`,
 * `[[timeline/2026-11-05]]`) names the page with exactly that id, whatever its
 * directory: a concept, a query, a timeline day or a profile's typed page. These
 * tests drive the real snapshot builder, renderer and server over a research-lite
 * profile project with a concept, a timeline day and a typed paper linking each
 * other, and pin that:
 *
 *   - the link renders as `#/<dir>/<slug>` with the `data-page-id` hover hook,
 *     and an unknown qualified target renders exactly like a dangling bare link;
 *   - each page's `outgoingLinks` carries it, from default and typed pages alike;
 *   - the graph draws concept ↔ typed-page edges but keeps the timeline out;
 *   - `/api/page` backlinks count a timeline day and a typed page as linkers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { renderPageHtml } from "../src/viewer/render.js";
import { startViewerServer } from "../src/viewer/server.js";
import type { ViewerSnapshot } from "../src/viewer/types.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

const ctx = useTempRoot();
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

const DAY = "timeline/2026-11-05";
const PAPER = "papers/scaling-laws";

/** A profile project whose concept, timeline day and typed paper link each other by qualified links. */
async function buildLinkedProject(): Promise<ViewerSnapshot> {
  await buildResearchLiteProject(ctx.dir);
  await mkdir(path.join(ctx.dir, "wiki/timeline"), { recursive: true });
  await writePage(path.join(ctx.dir, "wiki/concepts"), "alpha", { title: "Alpha" },
    `See [[${PAPER}|Scaling]], [[${DAY}#Morning|Thursday]] and [[papers/missing]].`);
  await writePage(path.join(ctx.dir, "wiki/timeline"), "2026-11-05", { title: "Thursday, November 5" },
    `Read [[${PAPER}|the paper]] and [[alpha]].`);
  await writePage(path.join(ctx.dir, "wiki/papers"), "scaling-laws", { title: "Scaling laws" },
    `Builds on [[concepts/alpha]]; discussed on [[${DAY}]].`);
  return buildViewerSnapshot(ctx.dir);
}

/** The page with `id` in the snapshot. */
function pageById(snapshot: ViewerSnapshot, id: string) {
  const found = snapshot.pages.find((page) => page.id === id);
  if (!found) throw new Error(`no page ${id}`);
  return found;
}

describe("qualified wikilinks in the snapshot", () => {
  it("resolves a qualified link from a default page to a typed page and a timeline day", async () => {
    const snapshot = await buildLinkedProject();
    const alpha = pageById(snapshot, "concepts/alpha");
    expect(alpha.outgoingLinks).toEqual([PAPER, DAY]);
    expect(alpha.danglingLinks).toEqual([{ slug: "papers/missing", display: "papers/missing" }]);
    expect(pageById(snapshot, DAY).outgoingLinks).toEqual([PAPER, "concepts/alpha"]);
  });

  it("resolves a typed page's own links, qualified and bare", async () => {
    const snapshot = await buildLinkedProject();
    expect(pageById(snapshot, PAPER).outgoingLinks).toEqual(["concepts/alpha", DAY]);
  });

  it("renders a resolved qualified link with its route and hover hook, and an unknown one as dangling", async () => {
    const snapshot = await buildLinkedProject();
    const { html } = renderPageHtml(pageById(snapshot, "concepts/alpha").body, snapshot, { isLoopback: true });
    expect(html).toContain(`<a class="wikilink" data-page-id="${PAPER}" href="#/${PAPER}">Scaling</a>`);
    expect(html).toContain(`<a class="wikilink" data-page-id="${DAY}" href="#/${DAY}">Thursday</a>`);
    expect(html).toContain('<span data-missing="true">[[papers/missing]]</span>');
  });

  it("draws concept and typed-page edges in the graph, and keeps the timeline out", async () => {
    const snapshot = await buildLinkedProject();
    const edges = snapshot.graph.edges.filter((edge) => edge.edgeKind === undefined).map((edge) => `${edge.source}>${edge.target}`);
    expect(edges).toContain(`concepts/alpha>${PAPER}`);
    expect(edges).toContain(`${PAPER}>concepts/alpha`);
    expect(edges.some((edge) => edge.includes("timeline/"))).toBe(false);
    const ids = snapshot.graph.nodes.map((node) => node.id);
    expect(ids.filter((id) => id === PAPER)).toHaveLength(1);
    expect(ids.some((id) => id.startsWith("timeline/"))).toBe(false);
    expect(snapshot.graph.nodes.find((node) => node.id === "papers/missing")?.isDangling).toBe(true);
    expect(snapshot.graph.nodes.find((node) => node.id === PAPER)?.degree).toBe(2);
  });

  it("keeps a timeline day out of recent pages", async () => {
    const snapshot = await buildLinkedProject();
    expect(snapshot.recentPages.some((row) => row.pageDirectory === "timeline")).toBe(false);
  });
});

describe("backlinks on /api/page", () => {
  /** The served payload of the page at `id`. */
  async function servedPage(snapshot: ViewerSnapshot, id: string): Promise<{ backlinks: string[] }> {
    const server = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
    servers.push(server);
    const response = await fetch(`http://${server.host}:${server.port}/api/page/${id}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ backlinks: string[] }>;
  }

  it("counts a timeline day and a concept as linking to a typed page", async () => {
    const snapshot = await buildLinkedProject();
    expect((await servedPage(snapshot, PAPER)).backlinks).toEqual(["concepts/alpha", DAY]);
  });

  it("counts a typed page and a concept as linking to a timeline day, and never the page itself", async () => {
    const snapshot = await buildLinkedProject();
    expect((await servedPage(snapshot, DAY)).backlinks).toEqual(["concepts/alpha", PAPER]);
    expect((await servedPage(snapshot, "concepts/alpha")).backlinks).toEqual([DAY, PAPER]);
  });
});
