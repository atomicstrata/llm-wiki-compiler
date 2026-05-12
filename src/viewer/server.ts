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
import { loadShellTemplate, substitutePageIndex } from "./shell.js";
import { ASSETS_DIR, handleAsset } from "./static-assets.js";
import type { PageDirectory } from "../export/types.js";
import type { ViewerSnapshot, ViewerPage } from "./types.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";

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
      writeJsonError(res, 500, "internal_error", err instanceof Error ? err.message : "unknown");
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
  const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);
  if (!isRouteRegistered(req.method, url.pathname)) {
    writeJsonError(res, 404, "not_found", `${req.method ?? "?"} ${url.pathname}`);
    return;
  }
  await routeRegistered(req, res, url, snapshot);
}

/**
 * Dispatch the request to whichever registered handler owns this path.
 * Caller has already confirmed the route is registered and the security
 * headers are set.
 */
async function routeRegistered(
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl: URL,
  snapshot: ViewerSnapshot,
): Promise<void> {
  if (parsedUrl.pathname === "/") return handleShell(res, snapshot);
  if (parsedUrl.pathname.startsWith("/assets/")) return handleAsset(res, parsedUrl.pathname);
  if (parsedUrl.pathname === "/api/pages") return handleApiPages(res, snapshot);
  if (parsedUrl.pathname === "/api/index") return handleApiIndex(res, snapshot);
  if (parsedUrl.pathname === "/api/health") return handleApiHealth(res, snapshot);
  if (parsedUrl.pathname.startsWith("/api/page/")) {
    return handleApiPage(res, parsedUrl.pathname, snapshot);
  }
  res.statusCode = 404;
  res.end();
}

/** True when (method, path) is one of the v1 registered routes. */
function isRouteRegistered(method: string | undefined, pathname: string): boolean {
  if (method !== "GET") return false;
  if (pathname === "/") return true;
  if (pathname.startsWith("/assets/")) return true;
  if (pathname === "/api/pages") return true;
  if (pathname === "/api/index") return true;
  if (pathname === "/api/health") return true;
  if (pathname.startsWith("/api/page/")) return true;
  return false;
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

/** True when the incoming `Host` header matches the configured bind. */
function isAcceptableHost(hostHeader: string, config: ViewerServerConfig): boolean {
  const expected = `${config.host}:${config.port}`;
  if (hostHeader === expected) return true;
  if (config.host === "127.0.0.1" && hostHeader === `localhost:${config.port}`) return true;
  return false;
}

/** True when the incoming `Origin` resolves to our own host:port. */
function isSameOrigin(origin: string, config: ViewerServerConfig): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === config.host && Number(parsed.port) === config.port;
  } catch {
    return false;
  }
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
    kind: typeof page.frontmatter.kind === "string" ? page.frontmatter.kind : "concept",
    summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
    updatedAt:
      typeof page.frontmatter.updatedAt === "string" ? (page.frontmatter.updatedAt as string) : "",
    warnings: page.warnings,
  };
}

/** `/api/index` — index.md state. `html` is empty in Slice 2; Slice 4 fills it. */
function handleApiIndex(res: ServerResponse, snapshot: ViewerSnapshot): void {
  if (!snapshot.index.available) {
    writeJsonError(res, 404, "index_unavailable", "wiki/index.md is not present.");
    return;
  }
  writeJson(res, 200, {
    html: "",
    outgoingLinks: snapshot.index.outgoingLinks,
    generatedAt: snapshot.generatedAt,
  });
}

/** `/api/health` — cheap status summary. */
async function handleApiHealth(res: ServerResponse, snapshot: ViewerSnapshot): Promise<void> {
  const health = await buildHealthResponse(snapshot);
  writeJson(res, 200, health);
}

/**
 * `/api/page/:directory/:slug` — single page payload in Slice 2's safe
 * placeholder shape (`html: ""`, `warnings` includes `render_pending`).
 * Slice 4 will swap in real rendered HTML and drop the render warning.
 */
function handleApiPage(res: ServerResponse, pathname: string, snapshot: ViewerSnapshot): void {
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
  writeJson(res, 200, pagePayload(page, snapshot));
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
function pagePayload(page: ViewerPage, snapshot: ViewerSnapshot): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html: "",
    citations: page.citations,
    outgoingLinks: page.outgoingLinks,
    frontmatter: page.frontmatter,
    warnings: [
      ...page.warnings,
      {
        code: "render_pending",
        message: "Markdown rendering ships in Slice 4.",
      },
    ],
    updatedAt:
      typeof page.frontmatter.updatedAt === "string" ? (page.frontmatter.updatedAt as string) : "",
    createdAt:
      typeof page.frontmatter.createdAt === "string" ? (page.frontmatter.createdAt as string) : "",
    generatedAt: snapshot.generatedAt,
  };
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
