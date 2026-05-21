/**
 * Subprocess integration tests for `llmwiki view`.
 *
 * These exercise the full CLI → snapshot → HTTP server path: we spawn
 * the compiled binary in a temp wiki, wait for the readiness line,
 * issue real fetches against `127.0.0.1`, and assert response shapes
 * match the Slice 2 contract. SIGINT/SIGTERM shutdown is also covered
 * here so the test fixture proves the signal handlers actually fire.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm, symlink, writeFile } from "fs/promises";
import path from "path";
import { LINT_CACHE_TIMESTAMP_PATTERN } from "../src/linter/cache.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import {
  startViewerCLI,
  useViewerProcessLifecycle,
  type ViewerProcessHandle,
} from "./fixtures/run-cli-server.js";

const { start: startViewer } = useViewerProcessLifecycle();

async function fetchJson(handle: ViewerProcessHandle, pathname: string): Promise<{
  status: number;
  body: unknown;
}> {
  const res = await fetch(`http://${handle.host}:${handle.port}${pathname}`);
  const body = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();
  return { status: res.status, body };
}

async function fetchText(handle: ViewerProcessHandle, pathname: string): Promise<{
  status: number;
  contentType: string | null;
  body: string;
}> {
  const res = await fetch(`http://${handle.host}:${handle.port}${pathname}`);
  return {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    body: await res.text(),
  };
}

describe("llmwiki view — readiness and snapshot", () => {
  it("prints a parseable readiness line on stdout", async () => {
    const root = await makeTempRoot("viewer-server-ready");
    const handle = await startViewer(root);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.stdout).toMatch(/Viewer ready at http:\/\/127\.0\.0\.1:\d+/);
  });

  it("/api/pages returns the project envelope with frozen counts", async () => {
    const root = await makeTempRoot("viewer-server-pages");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "Body.");
    await writePage(path.join(root, "wiki/queries"), "q", { title: "Q" }, "Body.");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/pages");
    expect(status).toBe(200);
    const envelope = body as Record<string, unknown>;
    const counts = envelope.counts as Record<string, number>;
    expect(counts.concepts).toBe(1);
    expect(counts.queries).toBe(1);
  });

  it("/api/page returns rendered html and no render_pending warning", async () => {
    const root = await makeTempRoot("viewer-server-render");
    await writePage(path.join(root, "wiki/concepts"), "x", { title: "X" }, "Body **bold**.");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/page/concepts/x");
    expect(status).toBe(200);
    const page = body as Record<string, unknown>;
    expect(typeof page.html).toBe("string");
    expect(page.html as string).toContain("<strong>bold</strong>");
    const warnings = page.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "render_pending")).toBe(false);
  });

  it("freezes counts at startup — post-startup file additions are invisible", async () => {
    const root = await makeTempRoot("viewer-server-frozen");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "B.");
    const handle = await startViewer(root);
    await writePage(path.join(root, "wiki/concepts"), "beta", { title: "Beta" }, "B.");
    const { body } = await fetchJson(handle, "/api/pages");
    const counts = (body as { counts: Record<string, number> }).counts;
    expect(counts.concepts).toBe(1);
  });

  it("/ serves the templated viewer shell with an embedded page-index blob", async () => {
    const root = await makeTempRoot("viewer-server-shell");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "B.");
    const handle = await startViewer(root);
    const out = await fetchText(handle, "/");
    expect(out.status).toBe(200);
    expect(out.contentType).toMatch(/^text\/html/);
    expect(out.body).toContain('<script type="application/json" id="page-index">');
    expect(out.body).toContain('"concepts/alpha"');
    expect(out.body).toContain("Alpha");
    // The marker should have been replaced; no raw HTML comment left behind.
    expect(out.body).not.toContain("<!--PAGE_INDEX-->");
  });

  it("/assets/viewer.js serves the bundled client script", async () => {
    const root = await makeTempRoot("viewer-server-asset-js");
    const handle = await startViewer(root);
    const out = await fetchText(handle, "/assets/viewer.js");
    expect(out.status).toBe(200);
    expect(out.contentType).toMatch(/javascript/);
    expect(out.body.length).toBeGreaterThan(0);
  });

  it("/assets/<missing> returns 404 asset_not_found with a static message (does not echo request path)", async () => {
    const root = await makeTempRoot("viewer-server-asset-missing");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/assets/nope-with-unique-marker-xyz.js");
    expect(status).toBe(404);
    const error = (body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("asset_not_found");
    expect(error.message).toBe("Asset not found.");
    expect(error.message).not.toContain("nope-with-unique-marker-xyz");
  });

  it("/assets/<bad-path> returns 400 bad_asset_path with a static message", async () => {
    const root = await makeTempRoot("viewer-server-asset-bad-path");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/assets/%2e%2e%2f%2e%2e%2fREADME.md");
    expect(status).toBe(400);
    const error = (body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("bad_asset_path");
    expect(error.message).toBe("Bad asset path.");
  });

  it("/api/search?q=… returns matching pages from the startup snapshot", async () => {
    const root = await makeTempRoot("viewer-server-search");
    await writePage(
      path.join(root, "wiki/concepts"),
      "attention",
      { title: "Attention Mechanism" },
      "Body text.",
    );
    await writePage(path.join(root, "wiki/queries"), "other", { title: "Unrelated" }, "Body.");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/search?q=attention");
    expect(status).toBe(200);
    const results = (body as { results: Array<{ id: string; matchedIn: string }> }).results;
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("concepts/attention");
    expect(results[0].matchedIn).toBe("title");
  });

  it("/api/search with empty q returns an empty result list (not 400)", async () => {
    const root = await makeTempRoot("viewer-server-search-empty");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/search?q=");
    expect(status).toBe(200);
    expect((body as { results: unknown[] }).results).toEqual([]);
  });

  it("rejects encoded traversal in the asset path with 400 bad_asset_path", async () => {
    const root = await makeTempRoot("viewer-server-asset-traversal");
    const handle = await startViewer(root);
    // `%2e%2e%2f` decodes to `../` — the spec's encoded-traversal case.
    const { status, body } = await fetchJson(handle, "/assets/%2e%2e%2f%2e%2e%2fREADME.md");
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("bad_asset_path");
  });

  describe("/assets/* path-confinement", () => {
    let symlinkPath: string | null = null;
    afterEach(async () => {
      if (symlinkPath) {
        await rm(symlinkPath, { force: true });
        symlinkPath = null;
      }
    });

    it("returns 404 for a symlink under dist/viewer/assets that points outside", async () => {
      const outside = await makeOutsideDir();
      const outsideFile = path.join(outside, "leaked.js");
      await writeFile(outsideFile, "// outside content");
      const distAssets = path.join(process.cwd(), "dist/viewer/assets");
      symlinkPath = path.join(distAssets, "leak.js");
      await rm(symlinkPath, { force: true });
      await symlink(outsideFile, symlinkPath);

      const root = await makeTempRoot("viewer-server-asset-symlink");
      const handle = await startViewer(root);
      const { status, body } = await fetchJson(handle, "/assets/leak.js");
      expect(status).toBe(404);
      expect((body as { error: { code: string } }).error.code).toBe("asset_not_found");
    });
  });

  it("counts do not include a symlinked concept that the collector dropped", async () => {
    const root = await makeTempRoot("viewer-server-symlink-counts");
    // One legitimate in-namespace page (will be counted).
    await writePage(path.join(root, "wiki/concepts"), "ok", { title: "OK" }, "B.");
    // An in-root file the attacker tries to surface as a concept via a
    // symlink — the collector drops it, so the counts must also drop it.
    await writeFile(
      path.join(root, "README.md"),
      "---\ntitle: README\n---\nProject readme.\n",
    );
    await symlink(path.join(root, "README.md"), path.join(root, "wiki/concepts/leaked.md"));

    const handle = await startViewer(root);
    const pages = await fetchJson(handle, "/api/pages");
    const health = await fetchJson(handle, "/api/health");

    const counts = (pages.body as { counts: { concepts: number; queries: number } }).counts;
    const healthCounts = health.body as { concepts: number; queries: number };
    expect(counts.concepts).toBe(1);
    expect(healthCounts.concepts).toBe(1);
    // And the leaked slug is absent from the page list itself.
    const pageRows = (pages.body as { pages: Array<{ slug: string }> }).pages;
    expect(pageRows.map((p) => p.slug)).not.toContain("leaked");
  });

  it("/api/graph returns nodes and edges arrays", async () => {
    const root = await makeTempRoot("viewer-server-graph-basic");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "See [[beta]].");
    await writePage(path.join(root, "wiki/concepts"), "beta", { title: "Beta" }, "Body.");
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/graph");
    expect(status).toBe(200);
    const graph = body as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("/api/graph includes a ghost node for a dangling wikilink", async () => {
    const root = await makeTempRoot("viewer-server-graph-dangling");
    await writePage(
      path.join(root, "wiki/concepts"),
      "alpha",
      { title: "Alpha" },
      "See [[missing-page|Custom Label]].",
    );
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/graph");
    const graph = body as { nodes: Array<{ isDangling?: boolean; title?: string }>; edges: unknown[] };
    const ghost = graph.nodes.find((n) => n.isDangling);
    expect(ghost).toBeDefined();
    expect(ghost?.title).toBe("Custom Label");
  });

  it("/api/health returns ISO timestamp shape when the lint cache exists", async () => {
    const root = await makeTempRoot("viewer-server-health");
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(
      path.join(root, ".llmwiki", "last-lint.json"),
      JSON.stringify({ warnings: 1, errors: 0, at: "2026-05-12T00:00:00.000Z" }),
    );
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/health");
    const health = body as { lint: { at: string } | null };
    expect(health.lint).not.toBeNull();
    expect(health.lint?.at).toMatch(LINT_CACHE_TIMESTAMP_PATTERN);
  });
});

describe("llmwiki view — graceful shutdown", () => {
  it("exits cleanly on SIGTERM", async () => {
    const root = await makeTempRoot("viewer-server-sigterm");
    const handle = await startViewer(root);
    await handle.kill();
    expect(handle.process.exitCode === 0 || handle.process.signalCode === "SIGTERM").toBe(true);
  });
});

describe("llmwiki view — privacy gate", () => {
  it("exits 1 when --host is supplied without --allow-lan", async () => {
    const root = await makeTempRoot("viewer-server-host-only");
    const handle = startViewerCLI(["--host", "0.0.0.0", "--port", "0"], root);
    await expect(handle).rejects.toThrow(/exited before ready/);
  });

  it("exits 1 when --allow-lan is supplied without --host", async () => {
    const root = await makeTempRoot("viewer-server-lan-only");
    const handle = startViewerCLI(["--allow-lan", "--port", "0"], root);
    await expect(handle).rejects.toThrow(/exited before ready/);
  });
});
