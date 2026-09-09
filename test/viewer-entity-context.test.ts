/**
 * Typed entity context is captured at startup, bounded, and served without
 * rereading relations or provenance. These checks use real profile/page stores
 * and the HTTP page endpoint, including missing endpoints and default parity.
 */
import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { useTempRoot } from "./fixtures/temp-root.js";
import { buildNewsroomProject, seedNewsroomRelations } from "./fixtures/newsroom-profile.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { startViewerServer } from "../src/viewer/server.js";
import { attachEntityContexts } from "../src/viewer/entity-context.js";
import type { RelationEdge } from "../src/viewer/graph.js";
import { jsonResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

const ctx = useTempRoot();
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

/** Serve a captured snapshot and return its typed article payload. */
async function serve(snapshot: Awaited<ReturnType<typeof buildViewerSnapshot>>) {
  const server = await startViewerServer(snapshot, { host: "127.0.0.1", port: 0 });
  servers.push(server);
  const response = await fetch(`http://${server.host}:${server.port}/api/page/articles/port-strike-latest`);
  expect(response.status).toBe(200);
  return response.json();
}

it("captures healthy relations and evidence then serves unchanged after disk mutation", async () => {
  await buildNewsroomProject(ctx.dir);
  await seedNewsroomRelations(ctx.dir);
  await mkdir(path.join(ctx.dir, "sources"));
  await writeFile(path.join(ctx.dir, "sources/report.md"), "Original source.\n");
  const page = path.join(ctx.dir, "wiki/articles/port-strike-latest.md");
  await writeFile(page, `${await readFile(page, "utf8")}\nEvidence ^[report.md:1-2]. Missing ^[absent.md:1-2]\n`);
  const snapshot = await buildViewerSnapshot(ctx.dir);
  await unlink(path.join(ctx.dir, "wiki/desks/metro.md"));
  await writeFile(page, "Changed after snapshot.");
  await writeFile(path.join(ctx.dir, "wiki/graph/relations.jsonl"), "corrupt after snapshot");
  const payload = await serve(snapshot);
  const context = payload.entityContext;
  expect(context.relationTotal).toBe(1);
  expect(context.relations[0]).toMatchObject({ type: "filed-under", direction: "outgoing", target: { id: "desks/metro", resolved: true } });
  expect(context.sources).toContainEqual({ file: "report.md", resolved: true, lines: { start: 1, end: 2 } });
  const doc = await mountPayload(payload);
  expect(doc.querySelector('[data-entity-context] a[href="#/desks/metro"]')?.textContent).toBe("Metro Desk");
  expect(doc.querySelector('[data-entity-context] a[href="#/_source/report.md?start=1&end=2"]')).not.toBeNull();
  expect(doc.querySelector('.citation-chip[data-file="report.md"] a')?.getAttribute("href")).toBe("#/_source/report.md?start=1&end=2");
  expect(doc.querySelector('.citation-chip[data-file="absent.md"] a')).toBeNull();
});

it.each(["missing", "invalid"])("keeps a %s relation endpoint visible as unresolved", async (condition) => {
  await buildNewsroomProject(ctx.dir);
  await seedNewsroomRelations(ctx.dir);
  const endpoint = path.join(ctx.dir, "wiki/desks/metro.md");
  if (condition === "missing") await unlink(endpoint);
  else await writeFile(endpoint, "---\nname: Metro Desk\n---\nInvalid without required stage.");
  const { entityContext: context } = await serve(await buildViewerSnapshot(ctx.dir));
  expect(context.relations[0].target).toEqual({ id: "desks/metro", resolved: false });
});

it("leaves default pages without a typed context key", async () => {
  await writeFile(path.join(ctx.dir, "wiki/concepts/basic.md"), "---\ntitle: Basic\n---\nBody.");
  const snapshot = await buildViewerSnapshot(ctx.dir);
  expect(snapshot.pages[0]).not.toHaveProperty("entityContext");
});

/** Render the actual server payload through the bundled client route. */
async function mountPayload(payload: Record<string, unknown>): Promise<Document> {
  const { dom, flush } = await mountViewerDom(url => {
    if (url.endsWith("/api/pages")) return jsonResponse({ project: {}, pages: [], counts: {}, profilePipeline: { entityTypes: [{ type: "articles", directory: "wiki/articles", fields: [] }] } });
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.includes("/api/page/")) return jsonResponse(payload);
    return null;
  }, "#/articles/port-strike-latest");
  await flush();
  return dom.window.document;
}

it("caps deterministic incoming neighborhoods while retaining their true total", async () => {
  await buildNewsroomProject(ctx.dir);
  const pages = (await buildViewerSnapshot(ctx.dir)).pages;
  const target = pages.find(page => page.id === "desks/metro")!;
  const relations = Array.from({ length: 105 }, (_, index) => ({ type: "filed-under", from: `articles/item-${index}`, to: target.id })) as RelationEdge[];
  const [projected] = attachEntityContexts([target], relations.reverse(), []);
  expect(projected.entityContext?.relationTotal).toBe(105);
  expect(projected.entityContext?.relations).toHaveLength(100);
  expect(projected.entityContext?.relations[0]).toMatchObject({ direction: "incoming", target: { id: "articles/item-0", resolved: false } });
  const symmetric = attachEntityContexts([target], [{ ...relations[0], direction: "symmetric" }], []);
  expect(symmetric[0].entityContext?.relations[0].direction).toBe("symmetric");
});

it("shows validated metadata provenance separately and refuses credential-bearing links", async () => {
  await buildNewsroomProject(ctx.dir);
  const page = (await buildViewerSnapshot(ctx.dir)).pages.find(page => page.entityType === "articles")!;
  const block = { connectorId: "fixture", connectorVersion: "1", sourceUrl: "https://metadata.test/record", fetchedAt: "2026-01-01", contentHash: "a".repeat(64), idempotencyKey: "b".repeat(64), externalFields: [] };
  page.frontmatter["x-llmwiki.connector"] = block;
  const [projected] = attachEntityContexts([page], [], []);
  const doc = await mountPayload({ ...projected, html: "<p>Body.</p>" });
  expect(doc.querySelector("[data-entity-context]")?.textContent).toContain("Where these details came from");
  expect(doc.querySelector("[data-entity-context]")?.textContent).toContain("not the original publication");
  expect(doc.querySelector('a[href="https://metadata.test/record"]')?.getAttribute("rel")).toBe("noopener noreferrer");
  block.sourceUrl = "https://user:secret@metadata.test/record";
  expect(attachEntityContexts([page], [], [])[0].entityContext?.connector).not.toHaveProperty("sourceUrl");
});

it("renders explicit empty states and leaves malformed provenance absent", async () => {
  await buildNewsroomProject(ctx.dir);
  const page = (await buildViewerSnapshot(ctx.dir)).pages.find(page => page.entityType === "articles")!;
  page.frontmatter["x-llmwiki.connector"] = { sourceUrl: "file:///private/secret" };
  const [projected] = attachEntityContexts([page], [], []);
  expect(projected.entityContext).not.toHaveProperty("connector");
  const doc = await mountPayload({ ...projected, html: "<p>Body.</p>" });
  expect(doc.querySelector("[data-entity-context]")?.textContent).toContain("No connections recorded yet.");
  expect(doc.querySelector("[data-entity-context]")?.textContent).toContain("No supporting source passages linked yet.");
});

it("opens a line-selected raw source independently from typed source pages", async () => {
  const requests: string[] = [];
  const { dom, flush } = await mountViewerDom(url => {
    requests.push(url);
    if (url.endsWith("/api/pages")) return jsonResponse({ project: {}, pages: [], counts: {}, sourceFilenames: ["report one.md"] });
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    if (url.endsWith("/api/source/report%20one.md/content")) return new Response("---\ntitle: Report\n---\nPhysical fourth line");
    if (url.endsWith("/api/source/report%20one.md")) return jsonResponse({ title: "Report", health: "ok", contentAccess: "available" });
    return null;
  }, "#/_source/report%20one.md?start=4&end=4");
  await flush();
  expect(dom.window.document.querySelector("[data-main-pane]")?.textContent).toContain("Source text used by the wiki");
  expect(dom.window.document.querySelector("mark")?.textContent).toContain("4  Physical fourth line");
  expect(requests.some(url => url.includes("/api/page/"))).toBe(false);
});
