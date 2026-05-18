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
const SIDEBAR_SCRIPT = path.resolve("src/viewer/assets/viewer-sidebar.js");
const RAIL_SCRIPT = path.resolve("src/viewer/assets/viewer-rail.js");

/** Page row shape the shell's `<script id="page-index">` blob carries. */
export interface EmbeddedPage {
  id: string;
  pageDirectory: "concepts" | "queries";
  slug: string;
  title: string;
  /** Frontmatter `kind` — used by the sidebar to group concepts on first paint. */
  kind?: string;
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
  const [shell, viewerSrc, searchSrc, sidebarSrc, railSrc] = await Promise.all([
    readFile(SHELL_PATH, "utf-8"),
    readFile(VIEWER_SCRIPT, "utf-8"),
    readFile(SEARCH_SCRIPT, "utf-8"),
    readFile(SIDEBAR_SCRIPT, "utf-8"),
    readFile(RAIL_SCRIPT, "utf-8"),
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
  dom.window.eval(rewriteModuleToGlobal(searchSrc, "__viewerSearchModule", ["wireSearch"]));
  dom.window.eval(
    rewriteModuleToGlobal(sidebarSrc, "__viewerSidebarModule", ["renderSidebar", "markActive"]),
  );
  dom.window.eval(
    rewriteModuleToGlobal(
      railSrc,
      "__viewerRailModule",
      ["renderProjectRail", "renderSupportRail", "clearSupportRail"],
    ),
  );
  dom.window.eval(rewriteViewerImports(viewerSrc));
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
 * Replace `export function …` lines with plain declarations and attach
 * the named exports to a window-scoped global so a rewritten viewer.js
 * can pick them up. JSDOM's `eval` doesn't drive ES-module loading, so
 * this is the cheapest workaround.
 */
function rewriteModuleToGlobal(source: string, globalName: string, exports: string[]): string {
  const objectLiteral = exports.map((name) => `${name}: ${name}`).join(", ");
  return (
    source.replace(/export function /g, "function ") +
    `\nwindow.${globalName} = { ${objectLiteral} };\n`
  );
}

/** Replace the viewer's static `import` lines with destructuring reads of the globals. */
function rewriteViewerImports(source: string): string {
  return source
    .replace(
      /import\s*\{\s*wireSearch\s*\}\s*from\s*['"]\.\/viewer-search\.js['"]\s*;/,
      "const { wireSearch } = window.__viewerSearchModule;",
    )
    .replace(
      /import\s*\{\s*renderSidebar\s*,\s*markActive\s*\}\s*from\s*['"]\.\/viewer-sidebar\.js['"]\s*;/,
      "const { renderSidebar, markActive } = window.__viewerSidebarModule;",
    )
    .replace(
      /import\s*\{\s*renderProjectRail\s*,\s*renderSupportRail\s*,\s*clearSupportRail\s*\}\s*from\s*['"]\.\/viewer-rail\.js['"]\s*;/,
      "const { renderProjectRail, renderSupportRail, clearSupportRail } = window.__viewerRailModule;",
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
