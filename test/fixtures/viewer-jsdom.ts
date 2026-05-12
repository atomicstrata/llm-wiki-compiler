/**
 * Mount the viewer's static assets into a JSDOM instance for DOM-level
 * tests. The shell template's `<script type="module">` ES-module loader
 * is not driven by JSDOM's `eval`, so this helper performs a small
 * source rewrite to turn the viewer's `import { … } from "./viewer-search.js"`
 * line into a `const … = window.__viewerSearchModule.…;` declaration
 * and exposes the search module's exports on a window-scoped global.
 *
 * Test fixtures pass an optional fetch responder; missing entries fall
 * through to a 404 so a test that forgot to wire `/api/pages` fails
 * loudly rather than silently producing an empty UI.
 */

import { readFile } from "fs/promises";
import path from "path";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";

const SHELL_PATH = path.resolve("src/viewer/assets/index.html");
const VIEWER_SCRIPT = path.resolve("src/viewer/assets/viewer.js");
const SEARCH_SCRIPT = path.resolve("src/viewer/assets/viewer-search.js");

/** Page row shape the shell's `<script id="page-index">` blob carries. */
export interface EmbeddedPage {
  id: string;
  pageDirectory: "concepts" | "queries";
  slug: string;
  title: string;
}

/** Fetch responder: returns a Response or `null` to fall through to 404. */
export type FetchResponder = (url: string) => Response | Promise<Response> | null | undefined;

export interface MountResult {
  dom: JSDOM;
  fetchMock: ReturnType<typeof vi.fn>;
  flush(): Promise<void>;
}

/**
 * Mount the viewer shell + scripts into JSDOM. Returns the dom and a
 * fetch-mock spy so tests can assert what was called. After mount, the
 * promise has been flushed past the initial microtask cycle.
 */
export async function mountViewerDom(
  pages: EmbeddedPage[],
  responder: FetchResponder,
): Promise<MountResult> {
  const [shell, viewerSrc, searchSrc] = await Promise.all([
    readFile(SHELL_PATH, "utf-8"),
    readFile(VIEWER_SCRIPT, "utf-8"),
    readFile(SEARCH_SCRIPT, "utf-8"),
  ]);
  const html = embedPageIndex(shell, pages);
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const response = await responder(url);
    return response ?? new Response(null, { status: 404 });
  });
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:0/",
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  (dom.window as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  dom.window.eval(rewriteSearchModuleToGlobal(searchSrc));
  dom.window.eval(rewriteViewerImport(viewerSrc));
  await flushMicrotasks();
  return { dom, fetchMock, flush: flushMicrotasks };
}

/** Drop a JSON-escaped page-index blob into the shell template marker. */
function embedPageIndex(shell: string, pages: EmbeddedPage[]): string {
  const json = JSON.stringify({ pages }).replace(/</g, "\\u003c");
  return shell.replace(
    "<!--PAGE_INDEX-->",
    `<script type="application/json" id="page-index">${json}</script>`,
  );
}

/**
 * Replace the search module's `export function …` lines with plain
 * declarations and attach `wireSearch` to `window.__viewerSearchModule`
 * so the rewritten viewer.js can pick it up via the global.
 */
function rewriteSearchModuleToGlobal(source: string): string {
  return (
    source.replace(/export function /g, "function ") +
    "\nwindow.__viewerSearchModule = { wireSearch };\n"
  );
}

/** Replace the viewer's static `import` line with a destructuring read of the global. */
function rewriteViewerImport(source: string): string {
  return source.replace(
    /import\s*\{\s*wireSearch\s*\}\s*from\s*['"]\.\/viewer-search\.js['"]\s*;/,
    "const wireSearch = window.__viewerSearchModule.wireSearch;",
  );
}

/** Standard JSON 200 helper for fetch responders. */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Settle microtasks (the initial /api/pages fetch + render). */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
