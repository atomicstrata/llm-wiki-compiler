/**
 * @file test/ingest-web-lazy.test.ts
 * @description Web ingestion loads jsdom (and Readability and Turndown) only
 * when a URL is actually ingested.
 *
 * The web-ingest module is reachable from every CLI command, and jsdom alone
 * added about 100 ms to the start-up of commands that never touch the web.
 * Importing the module must not load jsdom; ingesting a URL must still turn
 * the page into markdown, both in-process and through the real CLI.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

/**
 * Whether jsdom has been loaded into this process. jsdom is CommonJS, so each
 * of its files lands in the shared module cache the moment it is evaluated;
 * observing the cache (rather than mocking jsdom) leaves the import untouched.
 */
function isJsdomLoaded(): boolean {
  return Object.keys(require.cache).some((file) => file.includes(`${path.sep}node_modules${path.sep}jsdom${path.sep}`));
}

const PAGE = `<!doctype html><html><head><title>Lazy Loading</title></head><body>
<article><h1>Lazy Loading</h1><p>Deferring heavy modules until they are needed keeps
command start-up fast for every command that never uses them.</p>
<p>Only the web ingestion path pays for the HTML parser.</p></article></body></html>`;

/** Serve PAGE on a local port for one test; returns its URL and a closer. */
async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/lazy`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("web ingestion loads jsdom lazily", () => {
  it("does not load jsdom on import, only when a URL is ingested", async () => {
    const { default: ingestWeb } = await import("../src/ingest/web.js");
    expect(isJsdomLoaded()).toBe(false);
    const page = await servePage();
    cleanups.push(page.close);
    const result = await ingestWeb(page.url);
    expect(isJsdomLoaded()).toBe(true);
    expect(result.title).toBe("Lazy Loading");
    expect(result.content).toContain("Only the web ingestion path pays for the HTML parser.");
  });

  it("ingests a URL through the real CLI into a markdown source", async () => {
    const page = await servePage();
    cleanups.push(page.close);
    const cwd = await mkdtemp(path.join(tmpdir(), "ingest-web-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    expectCLIExit(await runCLI(["ingest", page.url], cwd), 0);
    const [file] = await readdir(path.join(cwd, "sources"));
    const saved = await readFile(path.join(cwd, "sources", file), "utf-8");
    expect(saved).toContain("Deferring heavy modules until they are needed");
    expect(saved).toContain(page.url);
  }, 60_000);
});
