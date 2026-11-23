/**
 * @file src/portable/surfaces/viewer.ts
 * @description The portable viewer: a read-only, loopback HTTP surface over a
 * portable project, for people.
 *
 * Today's viewer verifies that the BYTES it serves are still the confined
 * file; it has no notion of who is asking. This one adds the missing half:
 * every request opens a session through the chokepoint and is authorized as
 * the principal the host derives from the viewer's own configured credential.
 * That credential never leaves this process — it is not in any page, header or
 * URL the browser sees — and a request can name no principal, role or label.
 *
 * It serves HTML for inspection (pages, search, a proposal's candidates and
 * their exact drafts) and the same data as JSON under `/api`. It is GET-only.
 * It cannot propose, approve or apply; a review page ends with the command to
 * run instead.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { ACCESS_NOTICE } from "../contracts.js";
import { pagedSurface, type PagedSurface } from "./paged-surface.js";
import { pagedRoute } from "./paged-viewer.js";
import { portableSurface, surfaceFailure, type OpenSession, type PortableSurface } from "./surface.js";
import { candidatePage, homePage, notFoundPage, pagePage, proposalPage } from "./viewer-html.js";

/** The host the viewer binds to and answers for. */
const LOOPBACK_HOST = "127.0.0.1";

/** A running portable viewer. */
export interface PortableViewer {
  readonly url: string;
  close(): Promise<void>;
}

/** What one request is answered with. */
interface Answer { status: number; type: "html" | "json"; body: string }

const html = (body: string, status = 200): Answer => ({ status, type: "html", body });
const json = (value: unknown, status = 200): Answer => ({ status, type: "json", body: JSON.stringify(value) });

/** `{visible: false}` and a value are the two shapes a labelled read has; unwrap or `null`. */
function visibleValue<T>(result: { visible: true; value: T } | { visible: false }): T | null {
  return result.visible ? result.value : null;
}

/** The JSON routes: the same reads the pages show, for tools. */
async function apiRoute(surface: PortableSurface, segments: string[], url: URL): Promise<Answer | null> {
  const [first, second, third, fourth] = segments;
  if (first === "pages" && second === undefined) return json(await surface.listPages());
  if (first === "search") return json(await surface.search(url.searchParams.get("q") ?? ""));
  if (first === "pages") return jsonOrMissing(visibleValue(await surface.readPage(second)));
  if (first !== "proposals" || third !== "candidates") return null;
  if (fourth === undefined) return json(await surface.listCandidates(second));
  return jsonOrMissing(visibleValue(await surface.readCandidate(second, fourth)));
}

/** A JSON value, or the one not-found answer. */
function jsonOrMissing(value: unknown): Answer {
  return value === null ? json({ kind: "not_found" }, 404) : json(value);
}

/** The home page: the page list, or the results of a search. */
async function homeRoute(surface: PortableSurface, url: URL): Promise<Answer> {
  const query = url.searchParams.get("q") ?? "";
  return html(homePage(query ? await surface.search(query) : await surface.listPages(), query));
}

/** One published page, or nothing when it cannot be seen. */
async function publishedPageRoute(surface: PortableSurface, id: string): Promise<Answer | null> {
  const page = visibleValue(await surface.readPage(id));
  return page === null ? null : html(pagePage(page, ACCESS_NOTICE));
}

/** A proposal's candidate list, or one candidate's exact draft. */
async function proposalRoute(surface: PortableSurface, proposal: string, rest: string[]): Promise<Answer | null> {
  if (rest.length === 0) return html(proposalPage(proposal, await surface.listCandidates(proposal)));
  if (rest.length !== 2 || rest[0] !== "candidates") return null;
  const view = visibleValue(await surface.readCandidate(proposal, rest[1]));
  return view === null ? null : html(candidatePage(view, ACCESS_NOTICE));
}

/** The HTML routes a person browses. */
async function pageRoute(surface: PortableSurface, segments: string[], url: URL): Promise<Answer | null> {
  const [first, second, ...rest] = segments;
  if (first === undefined) return homeRoute(surface, url);
  if (second === undefined) return null;
  if (first === "pages" && rest.length === 0) return publishedPageRoute(surface, second);
  return first === "proposals" ? proposalRoute(surface, second, rest) : null;
}

/**
 * True when the request was addressed to this exact loopback listener and is
 * something a browser may be allowed to do here.
 *
 * A person arrives by typing the URL, a bookmark or a link from elsewhere:
 * that is a cross-site TOP-LEVEL navigation to a document, and it is allowed.
 * What is refused is another site reading this viewer from script or as a
 * subresource. No CORS header is ever sent, so such a read could not see the
 * response anyway; refusing it also keeps it from being made at all.
 */
function isAllowedLoopbackRequest(request: http.IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  if (host !== `${LOOPBACK_HOST}:${port}` && host !== `localhost:${port}`) return false;
  if (request.headers["sec-fetch-site"] !== "cross-site") return true;
  return request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document";
}

/** The version 1 surface and the paged surface beside it, bound to the same way of opening sessions. */
interface ViewerSurfaces { v1: PortableSurface; paged: PagedSurface }

/** Route one acceptable GET to its answer, or `null` when there is no such route. */
function routeRequest(surfaces: ViewerSurfaces, request: http.IncomingMessage, port: number): Promise<Answer | null> {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const wantsJson = segments[0] === "api";
  const route = wantsJson ? segments.slice(1) : segments;
  // The paged routes sit beside the version 1 routes and change none of them.
  if (route[0] === "scale") return pagedRoute(surfaces.paged, route.slice(1), url, wantsJson);
  return wantsJson ? apiRoute(surfaces.v1, route, url) : pageRoute(surfaces.v1, segments, url);
}

/** Answer one request. Any failure — a denial, a bad URL, a bug — is the same not-found. */
async function respond(surface: ViewerSurfaces, request: http.IncomingMessage, port: number): Promise<Answer> {
  const wantsJson = (request.url ?? "").startsWith("/api/");
  const missing = wantsJson ? json({ kind: "not_found" }, 404) : html(notFoundPage(), 404);
  if (request.method !== "GET" || !isAllowedLoopbackRequest(request, port)) return missing;
  try {
    return (await routeRequest(surface, request, port)) ?? missing;
  } catch (error) {
    const failure = surfaceFailure(error);
    return failure.kind === "refused" && wantsJson ? json(failure, 409) : missing;
  }
}

/** Response headers: no script, no framing, no cross-origin reads, nothing sniffed. */
function headersFor(type: Answer["type"]): Record<string, string> {
  return {
    "content-type": type === "html" ? "text/html; charset=utf-8" : "application/json",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Start the portable viewer on a loopback port.
 *
 * @param open - Opens a session for each request, from the viewer's own configured credential.
 */
export async function startPortableViewer(open: OpenSession, options: { port?: number } = {}): Promise<PortableViewer> {
  const surface: ViewerSurfaces = { v1: portableSurface(open), paged: pagedSurface(open) };
  const server = http.createServer((request, response) => {
    const { port } = server.address() as AddressInfo;
    void respond(surface, request, port).then((answer) => {
      response.writeHead(answer.status, headersFor(answer.type));
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
