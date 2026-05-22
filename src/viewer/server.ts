/**
 * Local read-only HTTP server for the llmwiki viewer.
 *
 * Built on Node's `http` module (no framework). The spec's mandatory
 * security headers (CSP, CORP, nosniff, Referrer-Policy) and the
 * Host / Origin / Sec-Fetch-Site rejection rules from
 * §Non-Negotiable Security Requirements apply to **every response**,
 * including 404s for unregistered paths and 403s for bad origin — see
 * `handleRequest` for the ordering rationale.
 *
 * The server reads from the frozen `ViewerSnapshot` for every request.
 * The single exception is `/api/health`, which calls `readLintCache`
 * per request — that's a documented cheap atomic-JSON contract, not a
 * filesystem rescan of the wiki.
 */

import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { buildHealthResponse } from "./health.js";
import { resolvePageKind } from "./graph.js";
import { loadShellTemplate, substitutePageIndex } from "./shell.js";
import { ASSETS_DIR, handleAsset } from "./static-assets.js";
import { renderPageHtml } from "./render.js";
import { searchPages } from "./search.js";
import type { PageDirectory } from "../export/types.js";
import type { ViewerSnapshot, ViewerPage } from "./types.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

/** Exact CSP string the spec mandates. Pinned here to keep the test contract obvious. */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";

/** Configuration knobs accepted by `startViewerServer`. */
interface ViewerServerConfig {
  /** Listening host. `--allow-lan` callers set this to a non-loopback bind address. */
  host: string;
  /** Listening port. `0` lets the OS pick a free port. */
  port: number;
}

/** Handle returned by `startViewerServer`. */
interface ViewerServerHandle {
  /** Actual port the server bound to (resolves `port: 0`). */
  port: number;
  /** Actual host the server bound to. */
  host: string;
  /** Graceful shutdown — closes the listener and resolves when all sockets drain. */
  close(): Promise<void>;
}

/**
 * Bind the configured server to its host/port and resolve once `listen`
 * fires. Errors during bind (occupied port, invalid host) reject so the
 * CLI surfaces a clean failure instead of hanging. The internal config
 * the request handler uses is the actually-bound port — not the one the
 * caller passed in — so `--port 0` correctly accepts Host headers that
 * carry the OS-assigned port.
 */
export async function startViewerServer(
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
): Promise<ViewerServerHandle> {
  const boundConfig: ViewerServerConfig = { ...config };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, snapshot, boundConfig).catch((err) => {
      // Per spec: never return raw thrown error text to the client.
      // The per-route handlers catch render/sanitize failures locally
      // and emit `render_failed`; reaching here means a genuinely
      // unexpected bug, so surface a generic envelope.
      void err;
      if (!res.headersSent) {
        writeJsonError(res, 500, "internal_error", "Unexpected server error.");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("server bound but address is null");
  boundConfig.port = address.port;
  return {
    host: config.host,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Dispatch a single request. The order matters:
 *   1. Set the mandatory security headers — every response carries them,
 *      including 404s for unknown paths and 403s for bad Host/Origin.
 *   2. Validate Host / Origin / Sec-Fetch-Site. Hostile-origin requests
 *      to unknown paths must still return 403, not a header-less 404.
 *   3. Dispatch to a registered route, or surface a JSON 404 envelope
 *      for anything else.
 * That ordering closes the DNS-rebind / cross-site leakage gap the
 * naive "404 first, then security" flow would leave behind.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  snapshot: ViewerSnapshot,
  config: ViewerServerConfig,
): Promise<void> {
  applySecurityHeaders(res);
  if (!validateOriginHeaders(req, config)) {
    writeJsonError(res, 403, "forbidden", "rejected by origin policy");
    return;
  }
  const url = new URL(req.url ?? "/", buildOriginBase(config));
  if (!isRouteRegistered(req.method, url.pathname)) {
    writeJsonError(res, 404, "not_found", `${req.method ?? "?"} ${url.pathname}`);
    return;
  }
  await routeRegistered(req, res, url, snapshot, LOOPBACK_HOSTS.has(config.host));
}

/**
 * Dispatch the request to whichever registered handler owns this path.
 * `isLoopback` controls whether the rendered citation chips include
 * `absolutePath` / editor-link payloads — non-loopback binds suppress
 * both per spec §Support Rail.
 */
async function routeRegistered(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): Promise<void> {
  if (parsedUrl.pathname === "/") return handleShell(res, snapshot);
  if (parsedUrl.pathname.startsWith("/assets/")) return handleAsset(res, parsedUrl.pathname);
  if (parsedUrl.pathname === "/api/pages") return handleApiPages(res, snapshot);
  if (parsedUrl.pathname === "/api/index") return handleApiIndex(res, snapshot, isLoopback);
  if (parsedUrl.pathname === "/api/health") return handleApiHealth(res, snapshot);
  if (parsedUrl.pathname === "/api/search") return handleApiSearch(res, parsedUrl, snapshot);
  if (parsedUrl.pathname === "/api/graph") return handleApiGraph(res, snapshot);
  if (parsedUrl.pathname.startsWith("/api/page/")) {
    return handleApiPage(res, parsedUrl.pathname, snapshot, isLoopback);
  }
  // Unreachable: `isRouteRegistered` is the gate, and every branch
  // there has a matching dispatch above. If it ever fires, the two
  // functions have drifted — fail loudly rather than silently 404.
  throw new Error(`route registration drift: no handler for ${parsedUrl.pathname}`);
}

/**
 * Exact-path registered routes for v1. Kept as a Set so additions are
 * just a string in one place and the membership test stays O(1).
 */
const REGISTERED_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/api/pages",
  "/api/index",
  "/api/health",
  "/api/search",
  "/api/graph",
]);

/** Prefix-based registered routes (assets and per-page API). */
const REGISTERED_PATH_PREFIXES: readonly string[] = ["/assets/", "/api/page/"];

/** True when (method, path) is one of the v1 registered routes. */
function isRouteRegistered(method: string | undefined, pathname: string): boolean {
  if (method !== "GET") return false;
  if (REGISTERED_EXACT_PATHS.has(pathname)) return true;
  return REGISTERED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Stamp every response with the mandatory security headers. Called
 * first in `handleRequest` so unregistered-route 404s and bad-origin
 * 403s carry the same hardening as the v1 API responses.
 */
function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Apply the Host / Origin / Sec-Fetch-Site rejection rules from
 * §Non-Negotiable Security Requirements. Returns false when a request
 * should be rejected with 403; the caller writes the error envelope.
 */
function validateOriginHeaders(req: IncomingMessage, config: ViewerServerConfig): boolean {
  const host = req.headers.host;
  if (!host || !isAcceptableHost(host, config)) return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (!isSameOrigin(origin, config)) return false;
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return false;
  return true;
}

/**
 * True when the incoming `Host` header matches the configured bind.
 * Handles IPv4 (`127.0.0.1:PORT`), IPv6 (`[::1]:PORT` — clients always
 * bracket the host portion when the Host header carries a literal IPv6
 * address per RFC 3986/7230), and the `localhost` alias on both
 * loopback families.
 */
function isAcceptableHost(hostHeader: string, config: ViewerServerConfig): boolean {
  for (const acceptable of buildAcceptableHostHeaders(config)) {
    if (hostHeader === acceptable) return true;
  }
  return false;
}

/** Every Host header value we accept for the current bind. */
function buildAcceptableHostHeaders(config: ViewerServerConfig): string[] {
  const formattedBind = formatHostHeader(config.host, config.port);
  const accepted = [formattedBind];
  if (config.host === "127.0.0.1" || config.host === "::1") {
    accepted.push(`localhost:${config.port}`);
  }
  return accepted;
}

/** True when the incoming `Origin` resolves to our own host:port. */
function isSameOrigin(origin: string, config: ViewerServerConfig): boolean {
  try {
    const parsed = new URL(origin);
    const expectedHostname = normalizeHostnameForOrigin(config.host);
    const originHostname = normalizeHostnameForOrigin(parsed.hostname);
    return originHostname === expectedHostname && Number(parsed.port) === config.port;
  } catch {
    return false;
  }
}

/**
 * Format a Host header value for the given bind. IPv6 addresses must
 * be bracketed (`[::1]:54391`); IPv4 and named hosts go in bare. The
 * heuristic for "literal IPv6" is a colon in the host portion — domain
 * names and IPv4 dotted-quads never contain `:`.
 */
function formatHostHeader(host: string, port: number): string {
  if (host.includes(":")) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

/**
 * Build a URL base suitable for the `new URL(req.url, base)` resolver.
 * IPv6 literal hosts must be bracketed inside a URL — `http://::1:PORT/`
 * is malformed and `new URL` throws. The bracketed form is the only
 * legal way to express a literal IPv6 host in a URL.
 */
function buildOriginBase(config: ViewerServerConfig): string {
  if (config.host.includes(":")) return `http://[${config.host}]:${config.port}`;
  return `http://${config.host}:${config.port}`;
}

/**
 * `URL.hostname` strips the brackets from a parsed IPv6 origin
 * (`new URL("http://[::1]/").hostname === "::1"`), so compare against
 * the bare form. Lowercased for case-insensitive equality (RFC 3986
 * says the host is case-insensitive).
 */
function normalizeHostnameForOrigin(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/**
 * Serve the templated viewer shell. Reads `index.html` lazily through
 * `loadShellTemplate` (process-cached), substitutes the page-index JSON
 * blob, and returns the result with `Content-Type: text/html`. A missing
 * template surfaces as a 500 `shell_missing` so the rest of the routes
 * stay usable when the asset bundle is incomplete.
 */
async function handleShell(res: ServerResponse, snapshot: ViewerSnapshot): Promise<void> {
  const template = await loadShellTemplate(ASSETS_DIR);
  if (template === null) {
    writeJsonError(res, 500, "shell_missing", "Viewer shell template not found on disk.");
    return;
  }
  const body = substitutePageIndex(template, snapshot.pages);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

/** `/api/pages` — full envelope with counts, recent pages, and page list. */
function handleApiPages(res: ServerResponse, snapshot: ViewerSnapshot): void {
  writeJson(res, 200, {
    project: snapshot.project,
    counts: {
      concepts: snapshot.counts.concepts,
      queries: snapshot.counts.queries,
      sourceFiles: snapshot.counts.sourceFiles,
      pendingReviews: snapshot.counts.pendingReviews,
    },
    index: { available: snapshot.index.available, href: snapshot.index.href },
    recentPages: snapshot.recentPages,
    pages: snapshot.pages.map(pageListRow),
    updatedAt: snapshot.generatedAt,
  });
}

/** Per-page row shape returned in `/api/pages.pages`. */
function pageListRow(page: ViewerPage): Record<string, unknown> {
  return {
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    kind: resolvePageKind(page.frontmatter),
    summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
    updatedAt:
      typeof page.frontmatter.updatedAt === "string" ? (page.frontmatter.updatedAt as string) : "",
    warnings: page.warnings,
  };
}

/** `/api/index` — rendered `wiki/index.md` with resolved outgoing links. */
function handleApiIndex(
  res: ServerResponse,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  if (!snapshot.index.available) {
    writeJsonError(res, 404, "index_unavailable", "wiki/index.md is not present.");
    return;
  }
  const rendered = tryRenderBody(snapshot.index.body, snapshot, isLoopback);
  if (rendered === null) {
    writeRenderFailed(res);
    return;
  }
  writeJson(res, 200, {
    html: rendered.html,
    outgoingLinks: snapshot.index.outgoingLinks,
    generatedAt: snapshot.generatedAt,
  });
}

/** Serve the frozen graph adjacency data for the `#/graph` route. */
function handleApiGraph(res: ServerResponse, snapshot: ViewerSnapshot): void {
  writeJson(res, 200, snapshot.graph);
}

/** `/api/health` — cheap status summary. */
async function handleApiHealth(res: ServerResponse, snapshot: ViewerSnapshot): Promise<void> {
  const health = await buildHealthResponse(snapshot);
  writeJson(res, 200, health);
}

/**
 * `/api/search?q=...` — substring search over the startup snapshot. The
 * query string is read directly from the parsed URL (Node's URL parser
 * has already percent-decoded it); `searchPages` does its own length
 * cap and tokenization. An empty or missing `q` returns an empty
 * results array, consistent with the no-tokens case.
 */
function handleApiSearch(
  res: ServerResponse,
  parsedUrl: URL,
  snapshot: ViewerSnapshot,
): void {
  const query = parsedUrl.searchParams.get("q") ?? "";
  writeJson(res, 200, searchPages(snapshot, query));
}

/**
 * `/api/page/:directory/:slug` — single page payload with server-rendered
 * sanitized HTML. The `render_pending` Slice-2 placeholder is gone; any
 * remaining warnings come from the collector (missing/malformed
 * frontmatter, missing title).
 */
function handleApiPage(
  res: ServerResponse,
  pathname: string,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  const segments = pathname.replace(/^\/api\/page\//, "").split("/");
  if (segments.length !== 2) {
    writeJsonError(res, 400, "bad_request", "Expected /api/page/:directory/:slug");
    return;
  }
  const [directorySegment, encodedSlug] = segments;
  const decodedSlug = safeDecodeSlug(directorySegment, encodedSlug);
  if (!decodedSlug) {
    writeJsonError(res, 400, "bad_request", "Invalid directory or slug.");
    return;
  }
  const page = snapshot.pages.find(
    (p) => p.pageDirectory === decodedSlug.directory && p.slug === decodedSlug.slug,
  );
  if (!page) {
    writeJsonError(res, 404, "page_not_found", `${decodedSlug.directory}/${decodedSlug.slug}`);
    return;
  }
  const rendered = tryRenderBody(page.body, snapshot, isLoopback);
  if (rendered === null) {
    writeRenderFailed(res);
    return;
  }
  writeJson(res, 200, pagePayload(page, snapshot, rendered.html));
}

/**
 * Decode the directory and slug segments together so a bad input on
 * either fails with a uniform 400. Resolves with `null` for any
 * structural rejection.
 */
function safeDecodeSlug(
  directorySegment: string,
  encodedSlug: string,
): { directory: PageDirectory; slug: string } | null {
  if (directorySegment !== "concepts" && directorySegment !== "queries") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
  try {
    assertSafeSlug(decoded);
  } catch (err) {
    if (err instanceof PathSafetyError) return null;
    throw err;
  }
  return { directory: directorySegment, slug: decoded };
}

/** Build the JSON payload for `/api/page/:dir/:slug`. */
function pagePayload(
  page: ViewerPage,
  snapshot: ViewerSnapshot,
  renderedHtml: string,
): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html: renderedHtml,
    citations: page.citations,
    outgoingLinks: page.outgoingLinks,
    frontmatter: page.frontmatter,
    warnings: page.warnings,
    updatedAt:
      typeof page.frontmatter.updatedAt === "string" ? (page.frontmatter.updatedAt as string) : "",
    createdAt:
      typeof page.frontmatter.createdAt === "string" ? (page.frontmatter.createdAt as string) : "",
    generatedAt: snapshot.generatedAt,
  };
}

/**
 * Wrap the renderer in a catch and return null on any thrown error.
 * Render or sanitize failures must emit the spec's `render_failed`
 * envelope rather than leak the raw thrown text — see `writeRenderFailed`.
 */
function tryRenderBody(
  body: string,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): { html: string } | null {
  try {
    return renderPageHtml(body, snapshot, { isLoopback });
  } catch {
    return null;
  }
}

/** Write the spec's exact `render_failed` 500 envelope. */
function writeRenderFailed(res: ServerResponse): void {
  writeJsonError(res, 500, "render_failed", "Could not render page.");
}

/** Write a JSON response body with the given status. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Standard `{ error: { code, message } }` envelope. */
function writeJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(res, status, { error: { code, message } });
}
