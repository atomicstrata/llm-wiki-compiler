/**
 * Mount the viewer's static assets into a JSDOM instance for DOM-level tests.
 *
 * JSDOM's `eval` does not drive ES-module loading, so every
 * `src/viewer/assets/viewer-*.js` module is wrapped in an IIFE, its named
 * exports collected, and the result registered on
 * `window.__viewerModules["./<name>.js"]`. Static `import` lines in each
 * module (and in the `viewer.js` entry point) are rewritten into registry
 * reads. Discovery is by directory scan, so adding a client module requires
 * no change here.
 *
 * `viewer-graph.js` is stubbed rather than evaluated — D3 is not exercised
 * under JSDOM. `viewer-theme-boot.js` is a classic script and is evaluated
 * verbatim before the modules, matching its `<head>` position in the shell.
 *
 * Test fixtures pass a fetch responder; unmatched URLs fall through to 404 so
 * a test that forgot to wire an endpoint fails loudly rather than silently
 * producing an empty UI.
 */

import { readFile, readdir } from "fs/promises";
import path from "path";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";

const ASSETS_DIR = path.resolve("src/viewer/assets");
const SHELL_PATH = path.join(ASSETS_DIR, "index.html");
const ENTRY_SCRIPT = "viewer.js";
const THEME_BOOT_SCRIPT = "viewer-theme-boot.js";

/**
 * Modules whose evaluation order matters because they import each other.
 * Anything not listed here is appended afterwards in directory order.
 *
 * `viewer-format.js` has no imports of its own (pure functions, no DOM
 * access) but is imported by several other modules, including
 * `viewer-dashboard.js` — whose name sorts alphabetically BEFORE
 * "viewer-format.js", so directory order alone would evaluate the
 * dependent first and crash destructuring an undefined registry entry.
 * Pinning it here (like viewer-dom.js and viewer-theme.js) guarantees it
 * registers before any dependent regardless of filename.
 *
 * `viewer-rail.js` has the same problem for the same reason: the Nebula
 * skeleton restructure (2026-08-05) made `viewer-dashboard.js` import
 * `renderDashboardRail` from it — the dashboard's receipt/next-actions/
 * snapshot-note panels now render through the shared support-rail module
 * instead of a private `.dashboard-rail` column — and "viewer-dashboard.js"
 * still sorts before "viewer-rail.js" alphabetically.
 *
 * `viewer-pattern.js` has the same problem again: `viewer-dashboard.js`
 * imports `buildPatternStrip` from it (the pattern strip's dismiss/
 * persistence logic was split out to stay under the 400-line file cap —
 * see that module's own header), and "viewer-dashboard.js" sorts before
 * "viewer-pattern.js" alphabetically too.
 *
 * `viewer-stat-card.js` has the same problem a third time, on the Overview
 * dashboard: `viewer-dashboard.js` imports `buildStatCard` from it, and
 * "viewer-dashboard.js" sorts alphabetically before "viewer-stat-card.js" —
 * directory order alone would evaluate that importer first and crash
 * destructuring an undefined registry entry.
 *
 * `viewer-health-lint.js` is pinned for the same class of reason even
 * though it happens to sort correctly today ("-" precedes "." so it already
 * lands before its importer "viewer-health.js"): the health screen's Lint
 * panel is imported by `viewer-health.js`, and leaving that dependency to
 * an incidental property of ASCII ordering is exactly the bet this list
 * exists to stop the repo making a fourth time.
 *
 * `viewer-pipeline-model.js` is pinned on the same principle: the Pipeline
 * panel's reachability model is imported by `viewer-pipeline.js`, and it too
 * only happens to sort first because "-" precedes ".".
 *
 * `viewer-nav-types.js` is the fifth instance of the original problem, not a
 * precautionary pin: the profile-vocabulary projection is imported by
 * `viewer-lists.js` (for a typed list's heading and empty state), and
 * "viewer-lists.js" sorts alphabetically BEFORE "viewer-nav-types.js".
 *
 * `viewer-routes.js` is the sixth: the typed list route's namespace is imported
 * by `viewer-nav-types.js` (which builds the href) and by `viewer-sidebar.js`
 * (which matches it), and "viewer-nav-types.js" sorts before "viewer-routes.js".
 * It is listed above its own importer for the same reason.
 *
 * `viewer-dashboard-vocabulary.js` is the seventh: `viewer-dashboard.js` imports
 * the profile-vocabulary projection from it, and sorts before it.
 */
const MODULE_ORDER = [
  "viewer-dom.js",
  "viewer-format.js",
  "viewer-theme.js",
  "viewer-routes.js",
  "viewer-nav-types.js",
  "viewer-dashboard-vocabulary.js",
  "viewer-rail.js",
  "viewer-pattern.js",
  "viewer-stat-card.js",
  "viewer-health-lint.js",
  "viewer-pipeline-model.js",
];

/** Match `import { a, b } from "./viewer-x.js";` including multi-line forms. */
const IMPORT_PATTERN = /import\s*\{([\s\S]*?)\}\s*from\s*['"](\.\/[\w.-]+\.js)['"]\s*;/g;

/** Rewrite every static import into a read from the module registry. */
function rewriteImports(source: string): string {
  return source.replace(
    IMPORT_PATTERN,
    (_match, names: string, specifier: string) =>
      `const {${names}} = window.__viewerModules[${JSON.stringify(specifier)}];`,
  );
}

/**
 * Match a top-level `export` declaration and capture the exported name.
 *
 * WHY strip exports at all: JSDOM's `eval` does not drive ES-module
 * loading, so a bare `export` keyword is a `SyntaxError` outside a real
 * `<script type="module">`. Every viewer-*.js module is therefore
 * stripped of its `export` keywords before being eval'd (see
 * `stripExportKeyword`, which reuses this exact pattern so "what counts
 * as an export" can never drift between matching and stripping) and
 * wrapped in an IIFE.
 *
 * Supported forms: `function`, `async function`, `const`, `let`, `var`,
 * `class` — every form a viewer module currently uses (`viewer-graph.js`
 * ships `export async function`) plus the forms most likely for a future
 * module (e.g. `export const foo = () => {}`). `export default` and
 * re-export (`export { a, b }`) are NOT supported: a module using either
 * fails loudly via `assertNoUnsupportedExports` below instead of
 * producing a cryptic `SyntaxError: Unexpected token 'export'` from
 * JSDOM with no pointer back to the cause.
 */
const EXPORT_PATTERN = /export\s+(?:async\s+function|function|const|let|var|class)\s+(\w+)/g;

/** A line whose first token is `export` — one EXPORT_PATTERN did not match and strip. */
const UNSTRIPPED_EXPORT_PATTERN = /^[ \t]*export\b.*$/m;

/** Collect the names a module exports (see EXPORT_PATTERN for supported forms). */
function exportedNames(source: string): string[] {
  return Array.from(source.matchAll(EXPORT_PATTERN)).map((m) => m[1]);
}

/** Strip the leading `export` keyword from every declaration EXPORT_PATTERN matches. */
function stripExportKeyword(source: string): string {
  return source.replace(EXPORT_PATTERN, (declaration) => declaration.replace(/^export\s+/, ""));
}

/**
 * Throw a diagnostic naming the module and the offending line when a
 * module uses an export form EXPORT_PATTERN does not recognise (e.g.
 * `export default`, `export { a, b }`). Without this check, the orphaned
 * `export` keyword reaches JSDOM's `eval` and fails with a bare
 * `SyntaxError: Unexpected token 'export'` that names neither the module
 * nor the line — this turns that into an actionable error instead.
 */
function assertNoUnsupportedExports(strippedBody: string, specifier: string): void {
  const match = strippedBody.match(UNSTRIPPED_EXPORT_PATTERN);
  if (!match) return;
  throw new Error(
    `${specifier} uses an export form the JSDOM harness does not support: "${match[0].trim()}". ` +
      "Supported forms: function, async function, const, let, var, class " +
      "(see EXPORT_PATTERN in test/fixtures/viewer-jsdom.ts).",
  );
}

/**
 * Wrap a module in an IIFE that returns its exports and assign it into the
 * registry. The IIFE gives each module its own scope, so module-level `let`
 * state (e.g. the sidebar's active filter) cannot leak between modules.
 */
function moduleToRegistryScript(source: string, specifier: string): string {
  const names = exportedNames(source);
  const body = stripExportKeyword(rewriteImports(source));
  assertNoUnsupportedExports(body, specifier);
  const literal = names.map((name) => `${name}: ${name}`).join(", ");
  return `window.__viewerModules[${JSON.stringify(specifier)}] = (function () {\n${body}\nreturn { ${literal} };\n})();`;
}

/** List the client modules to mount, honouring MODULE_ORDER first. */
async function listModuleFiles(): Promise<string[]> {
  const entries = await readdir(ASSETS_DIR);
  const modules = entries.filter(
    (name) =>
      name.startsWith("viewer-") &&
      name.endsWith(".js") &&
      name !== THEME_BOOT_SCRIPT,
  );
  const ordered = MODULE_ORDER.filter((name) => modules.includes(name));
  const rest = modules.filter((name) => !ordered.includes(name)).sort();
  return [...ordered, ...rest];
}

/**
 * Read a file from the assets dir, returning null when it does not exist.
 * Only ENOENT is treated as "optional and absent" — a permissions error or
 * any other filesystem failure re-throws, so a broken fixture fails loudly
 * instead of silently rendering as if the file were never there.
 */
async function readOptional(name: string): Promise<string | null> {
  try {
    return await readFile(path.join(ASSETS_DIR, name), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * One `/api/pages` page row, reduced to the fields the shell and support-rail
 * suites build envelopes from. The client's only page list comes from that
 * endpoint — the server-embedded `#page-index` blob it used to read is gone
 * (see `src/viewer/shell.ts`) — so this is a wire shape, not a shell shape.
 */
export interface PageRow {
  id: string;
  pageDirectory: "concepts" | "queries";
  slug: string;
  title: string;
  /** Resolved page kind; the sidebar groups concepts by it. */
  kind?: string;
}

/** Fetch responder: returns a Response or `null` to fall through to 404. */
export type FetchResponder = (url: string) => Response | Promise<Response> | null | undefined;

/** Resolution mode for the stubbed graph module's `loadGraph()` (see `setupGraphStub`). */
export type GraphHandleMode = "present" | "deferred";

/** The outcome a `"deferred"`-mode graph load can be settled to via `resolveGraphHandle`. */
export type GraphHandleOutcome = "present" | "none";

/** The control handle shape the real `loadGraph()` resolves to once a graph has rendered. */
interface GraphHandle {
  fit: () => void;
}

export interface MountResult {
  dom: JSDOM;
  fetchMock: ReturnType<typeof vi.fn>;
  flush(): Promise<void>;
  /** Spy backing the stubbed graph handle's `fit()` — observable from the test. */
  graphFitMock: ReturnType<typeof vi.fn>;
  /**
   * Settle a `"deferred"`-mode graph load. `"present"` resolves `loadGraph()`
   * to a handle backed by `graphFitMock`; `"none"` resolves it to `null`,
   * mirroring an empty or failed graph. No-op in `"present"` mode — that
   * mode's `loadGraph()` has already resolved by the time `mountViewerDom`
   * returns.
   */
  resolveGraphHandle(outcome: GraphHandleOutcome): void;
}

/** A promise plus its external resolver, so a test can control when the stubbed loadGraph() settles. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Stub `viewer-graph.js` in the module registry — D3 is not exercised under
 * JSDOM (see file header). `loadGraph` resolves `loadGraphResult`, mirroring
 * the real module's contract: a handle exposing `fit()`, or `null` when
 * nothing was rendered. `LEGEND_KINDS` is real data (not a D3 call),
 * mirrored verbatim from viewer-graph.js so the dashboard's compact legend
 * (viewer-dashboard.js) renders its real four entries under this harness too.
 */
function registerGraphStub(win: Window & typeof globalThis, loadGraphResult: Promise<GraphHandle | null>): void {
  const registry = (win as unknown as { __viewerModules: Record<string, unknown> }).__viewerModules;
  registry["./viewer-graph.js"] = {
    loadGraph: () => loadGraphResult,
    staleIdsFromEnvelope: () => new Set(),
    LEGEND_KINDS: [
      { label: "concept", kind: "concept" },
      { label: "entity", kind: "entity" },
      { label: "stale", kind: "stale" },
      { label: "dangling", kind: "dangling" },
    ],
  };
}

/**
 * Wire the stubbed graph module into the registry for one mount, and return
 * the two hooks a test needs: the `fit()` spy, and a resolver usable when
 * `mode` is `"deferred"`. `"present"` resolves `loadGraph()` immediately —
 * the common case, mirroring a graph that rendered successfully.
 */
function setupGraphStub(
  win: Window & typeof globalThis,
  mode: GraphHandleMode,
): { graphFitMock: ReturnType<typeof vi.fn>; resolveGraphHandle: (outcome: GraphHandleOutcome) => void } {
  const graphFitMock = vi.fn();
  const deferred = createDeferred<GraphHandle | null>();
  const resolveGraphHandle = (outcome: GraphHandleOutcome) =>
    deferred.resolve(outcome === "present" ? { fit: graphFitMock } : null);
  const loadGraphResult = mode === "present" ? Promise.resolve({ fit: graphFitMock }) : deferred.promise;
  registerGraphStub(win, loadGraphResult);
  return { graphFitMock, resolveGraphHandle };
}

/**
 * Mount the viewer shell + scripts into JSDOM. Returns the dom and a
 * fetch-mock spy so tests can assert what was called. After mount, the
 * promise has been flushed past the initial microtask cycle.
 *
 * @param startHash - Optional initial `location.hash` value (e.g. `"#/graph"`).
 *   Set before scripts run so `main()` sees this hash as the entry route.
 * @param graphHandle - Resolution mode for the stubbed graph module's
 *   `loadGraph()` (see `setupGraphStub`). `"present"` (default) resolves
 *   immediately to a handle backed by the returned `graphFitMock`.
 *   `"deferred"` leaves the promise pending until the test calls the
 *   returned `resolveGraphHandle()`, so a test can observe a dashboard
 *   Fit-style control in its not-yet-resolved state first.
 */
export async function mountViewerDom(
  responder: FetchResponder,
  startHash?: string,
  graphHandle: GraphHandleMode = "present",
): Promise<MountResult> {
  const [html, entrySrc, moduleFiles] = await Promise.all([
    readFile(SHELL_PATH, "utf-8"),
    readFile(path.join(ASSETS_DIR, ENTRY_SCRIPT), "utf-8"),
    listModuleFiles(),
  ]);
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const response = await responder(url);
    return response ?? new Response(null, { status: 404 });
  });
  const startUrl = startHash ? `http://127.0.0.1:0/${startHash}` : "http://127.0.0.1:0/";
  const dom = new JSDOM(html, {
    url: startUrl,
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  (dom.window as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  dom.window.eval("window.__viewerModules = {};");
  const { graphFitMock, resolveGraphHandle } = setupGraphStub(dom.window, graphHandle);
  const themeBoot = await readOptional(THEME_BOOT_SCRIPT);
  if (themeBoot) dom.window.eval(themeBoot);
  for (const name of moduleFiles) {
    if (name === "viewer-graph.js") continue;
    const source = await readOptional(name);
    if (source === null) continue;
    dom.window.eval(moduleToRegistryScript(source, `./${name}`));
  }
  dom.window.eval(rewriteImports(entrySrc));
  await flushMicrotasks();
  return { dom, fetchMock, flush: flushMicrotasks, graphFitMock, resolveGraphHandle };
}

/**
 * Minimal `/api/pages` envelope for an empty demo project: no pages, no
 * index. The common starting point for tests that only need a successful
 * bootstrap fetch and do not care about page content (theme toggle,
 * pattern-strip dismissal, and similar chrome-only behaviour) — kept here,
 * rather than copied into each such test file, once duplicating it started
 * tripping fallow's clone-group check.
 */
export const EMPTY_DEMO_ENVELOPE = {
  project: { title: "demo", rootName: "demo" },
  counts: {},
  pages: [],
  recentPages: [],
  index: { available: false },
};

/** Profile id the profile-project bootstrap fixture reports. */
export const PROFILE_FIXTURE_ID = "newsroom";

/** Serve the bootstrap pair from `envelope`, or null when `url` is neither endpoint. */
function bootstrapResponse(url: string, envelope: unknown): Response | null {
  if (url.endsWith("/api/pages")) return jsonResponse(envelope);
  if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
  return null;
}

/**
 * Serve the two bootstrap endpoints for an empty DEFAULT-profile project, or
 * null when `url` is neither — the tail every per-request route test's responder
 * falls through to once it has handled its own endpoint.
 *
 * Kept here for the same reason {@link EMPTY_DEMO_ENVELOPE} is: the #/reviews
 * and #/workflows route tests each need exactly this pair ahead of their own
 * endpoint, and writing it out twice tripped fallow's clone-group check.
 */
export function emptyBootstrapResponse(url: string): Response | null {
  return bootstrapResponse(url, EMPTY_DEMO_ENVELOPE);
}

/**
 * The same pair for a project with a profile installed.
 *
 * Workflows are declared BY a profile, so a default-profile project can never
 * have a run and the sidebar omits the entry entirely (see
 * `isNavItemApplicable`, viewer-sidebar.js). A #/workflows test therefore has to
 * bootstrap as a profile project or it is asserting against a nav that correctly
 * does not include it.
 */
export function profileBootstrapResponse(url: string): Response | null {
  return bootstrapResponse(url, { ...EMPTY_DEMO_ENVELOPE, profileId: PROFILE_FIXTURE_ID });
}

/**
 * Serve the same pair from a caller-supplied `/api/pages` envelope.
 *
 * The route tests that render FROM the bootstrap envelope (rather than from
 * their own per-visit endpoint) each need this two-line responder around their
 * own fixture, and writing it out per file is what fallow's clone-group check
 * flags — the same reason {@link emptyBootstrapResponse} lives here.
 */
export function envelopeBootstrapResponse(envelope: unknown): FetchResponder {
  return (url) => bootstrapResponse(url, envelope);
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
