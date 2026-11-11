/**
 * `llmwiki view-v2` end to end against the built CLI: the shell it serves is
 * the v2 client, the client's bundle loads through `/assets/v2/`, and the same
 * server answers the JSON API and the source image route the client depends on,
 * including the generated timeline pages, which open like any other page but
 * stay out of the recently updated list and the graph.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { startViewerV2CLI, type ViewerProcessHandle } from "./fixtures/run-cli-server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const PAGE = "---\ntitle: Kiln Notes\nsources: [shot.md]\n---\n\n# Kiln Notes\n\nFired at cone 6. ^[shot.md:5]\n\n## Sources\n\n- [Kiln log](shot.md)\n";
const SOURCE = '---\nimages: ["shot.png"]\n---\n\nKiln log, cone 6.\n';
const DAY = "---\ntitle: Monday, May 4, 2026\nsummary: Fired the kiln.\nsources: [shot.md]\ntimeline: daily\ndate: 2026-05-04\n---\n\nFired at cone 6. ^[shot.md:5-5]\n\n## Pages from this day\n\n- [[kiln-notes|Kiln Notes]]\n";

describe("llmwiki view-v2", () => {
  let root: string;
  let viewer: ViewerProcessHandle | undefined;

  beforeEach(async () => {
    root = await makeTempRoot("view-v2");
    await mkdir(path.join(root, "sources/images"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/kiln-notes.md"), PAGE);
    await writeFile(path.join(root, "sources/shot.md"), SOURCE);
    await writeFile(path.join(root, "sources/images/shot.png"), PNG);
    await mkdir(path.join(root, "wiki/timeline"), { recursive: true });
    await writeFile(path.join(root, "wiki/timeline/2026-05-04.md"), DAY);
    viewer = await startViewerV2CLI([], root);
  });
  afterEach(async () => {
    await viewer?.kill();
    await rm(root, { recursive: true, force: true });
  });

  const url = (pathname: string): string => `http://127.0.0.1:${viewer!.port}${pathname}`;

  it("serves the v2 client shell and a loadable bundle", async () => {
    const shell = await (await fetch(url("/"))).text();
    const bundle = /src="(\/assets\/v2\/[^"]+\.js)"/.exec(shell)?.[1];
    expect(bundle).toBeDefined();
    const script = await fetch(url(bundle!));
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toContain("javascript");
  });

  it("answers the page, source and image requests the client makes", async () => {
    const page = await (await fetch(url("/api/page/concepts/kiln-notes"))).json();
    expect(page.frontmatter.sources).toEqual(["shot.md"]);
    expect(page.html).toContain('data-file="shot.md"');
    expect(page.html).toContain('<a href="#/_source/shot.md">Kiln log</a>');
    expect(await (await fetch(url("/api/source/shot.md/content"))).text()).toBe(SOURCE);
    expect((await (await fetch(url("/api/source/shot.md"))).json()).images).toEqual(["shot.png"]);
    const image = await fetch(url("/api/source-image/shot.md/shot.png"));
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("opens a timeline page with its links resolved, and keeps it out of recent pages and the graph", async () => {
    const day = await fetch(url("/api/page/timeline/2026-05-04"));
    expect(day.status).toBe(200);
    expect((await day.json()).html).toContain('data-page-id="concepts/kiln-notes"');
    const wiki = await (await fetch(url("/api/pages"))).json();
    expect(wiki.pages.map((row: { id: string }) => row.id).sort()).toEqual(["concepts/kiln-notes", "timeline/2026-05-04"]);
    expect(wiki.recentPages.map((row: { id: string }) => row.id)).toEqual(["concepts/kiln-notes"]);
    const graph = await (await fetch(url("/api/graph"))).json();
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(["concepts/kiln-notes"]);
  });
});
