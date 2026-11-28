/**
 * @file src/portable/surfaces/paged-viewer.ts
 * @description The paged routes of the read-only portable viewer: one listing
 * page with a link to the next, bounded keyword search, and one opened page.
 *
 * It keeps every rule of the viewer it extends. It is GET-only, has no script
 * and no form that changes anything, treats everything from a project as
 * untrusted text, and makes each request through the surface, so each is
 * authorized as the principal the host derives. A cursor travels in the URL
 * because it is only a position: it carries no authority, and the next page is
 * decided again from current host state.
 *
 * Every page says what it is looking at. The one store that can serve these
 * routes in slice S1 is a fixture-loaded volatile simulation, and the banner
 * says so in words nobody can mistake for a person's own project.
 */

import type {
  PagedListingV2, PagedOpenedV2, PagedRefusedV2, PagedSearchResultsV2, ScaleCustodyV2,
} from "../scale/contracts.js";
import type { PagedSurface } from "./paged-surface.js";
import { escapeHtml } from "./viewer-html.js";

/** What one paged request is answered with. */
export interface PagedAnswer { status: number; type: "html" | "json"; body: string }

const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const STATUS_REFUSED = 409;

const BANNERS: Readonly<Record<ScaleCustodyV2, string>> = {
  "simulated-volatile-fixture":
    "<strong>SIMULATED · VOLATILE · FIXTURE-LOADED.</strong> Synthetic pages on an in-memory store that is lost "
    + "when this process exits. This is not your own project, not a hosted service and not durable storage.",
  "v1-compatibility": "<strong>Version 1 store.</strong> It can open one page here, but it has no paged listing or index.",
};

/** Wrap a body in the paged viewer's shell. */
function shell(title: string, custody: ScaleCustodyV2 | null, body: string, notice: string, query = ""): string {
  const banner = custody === null ? "" : `<p class="banner">${BANNERS[custody]}</p>`;
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} · llmwiki portable viewer (paged)</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}",
    "pre{white-space:pre-wrap;border:1px solid #ccc;padding:1rem}code{word-break:break-all}",
    ".banner{border:2px solid #a40;background:#fff4e5;color:#000;padding:.75rem}</style>",
    "</head>", "<body>", banner,
    '<p><a href="/scale">Pages, first page</a> · read-only portable viewer, paged (prototype)</p>',
    `<form method="get" action="/scale"><input name="q" value="${escapeHtml(query)}" aria-label="Search published pages">`
    + "<button>Search</button></form>",
    `<h1>${escapeHtml(title)}</h1>`, body, `<p><small>${escapeHtml(notice)}</small></p>`,
    "</body>", "</html>",
  ].join("\n");
}

/** Links to pages, or a line saying there is nothing to show. */
function pageLinks(items: readonly { id: string; title: string }[], detail: (index: number) => string = () => ""): string {
  if (items.length === 0) return "<p>Nothing to show.</p>";
  const rows = items.map((item, index) =>
    `<li><a href="/scale/pages/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a>${detail(index)}</li>`);
  return `<ul>${rows.join("")}</ul>`;
}

/** One listing page, with the link to the next one when there is one. */
function listingPage(listed: PagedListingV2): string {
  const next = listed.cursor === null
    ? "<p>End of the listing.</p>"
    : `<p><a rel="next" href="/scale?cursor=${encodeURIComponent(listed.cursor)}">Next page →</a></p>`;
  const body = `${pageLinks(listed.items)}${next}<p><small>Catalog fence <code>${escapeHtml(listed.fence)}</code>. `
    + "No page body was read to build this list.</small></p>";
  return shell("Pages", listed.custody, body, listed.notice);
}

/** Search results, with what the scan cost and whether the answer is complete. */
function searchPage(query: string, found: PagedSearchResultsV2): string {
  const truncated = found.truncated
    ? "<p><strong>Truncated:</strong> the scan budget ended this search, so matches may be missing.</p>" : "";
  const behind = found.availability === "index_behind"
    ? "<p><strong>Index behind:</strong> some pages you can read were not searched until the index catches up.</p>" : "";
  const cost = `<p><small>Read ${found.scan.postingsRead} of a budget of ${found.scan.budget} postings.</small></p>`;
  // Two different limits: how many hits are SHOWN, and how many postings the scan may READ.
  const shown = `<p><small>Showing ${found.items.length} best-scoring matches; at most the result limit is shown `
    + "(20 unless the request names another), which is separate from the scan budget.</small></p>";
  const links = pageLinks(found.items, (index) => ` <small>score ${found.items[index].score}</small>`);
  return shell(`Search: ${query}`, found.custody, links + shown + truncated + behind + cost, found.notice, query);
}

/** One opened page, shown as the exact text that is stored. */
function openedPage(opened: PagedOpenedV2): string {
  const { page } = opened;
  const body = `<p>Digest <code>${escapeHtml(page.digest)}</code> · ${page.byteCount} bytes</p>`
    + `<pre>${escapeHtml(page.body)}</pre>`;
  return shell(page.title, opened.custody, body, opened.notice);
}

/** A refusal, with the one thing a person can do about a stale cursor. */
function refusedPage(refusal: PagedRefusedV2): string {
  const restart = refusal.code === "stale_cursor"
    ? '<p>The project changed since that page was listed. <a href="/scale">Start again from the first page</a>.</p>' : "";
  const named = refusal.capability === undefined ? "" : ` (<code>${escapeHtml(refusal.capability)}</code>)`;
  return shell("Refused", null, `<p>Refused: <code>${escapeHtml(refusal.code)}</code>${named}.</p>${restart}`, refusal.notice);
}

/** Shape any paged outcome as JSON or as its page. */
function answerFor(outcome: { kind: string }, wantsJson: boolean, render: () => string): PagedAnswer {
  const status = outcome.kind === "refused" ? STATUS_REFUSED : outcome.kind === "not_visible" ? STATUS_NOT_FOUND : STATUS_OK;
  if (wantsJson) return { status, type: "json", body: JSON.stringify(outcome) };
  if (outcome.kind === "not_visible") return { status, type: "html", body: shell("Not found", null, "<p>There is nothing here that you can see.</p>", "Results reflect your access") };
  const body = outcome.kind === "refused" ? refusedPage(outcome as PagedRefusedV2) : render();
  return { status, type: "html", body };
}

/** The requested page size, when the URL names one. */
function limitOf(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  return raw === null ? undefined : Number(raw);
}

/**
 * Route one paged GET. `segments` are the path segments after `scale`.
 *
 * @returns The answer, or `null` when there is no such paged route.
 */
export async function pagedRoute(
  surface: PagedSurface, segments: readonly string[], url: URL, wantsJson: boolean,
): Promise<PagedAnswer | null> {
  const [first, second, ...rest] = segments;
  const query = url.searchParams.get("q") ?? "";
  if (rest.length > 0) return null;
  if (first === "pages" && second !== undefined) {
    const opened = await surface.openPage(second);
    return answerFor(opened, wantsJson, () => openedPage(opened as PagedOpenedV2));
  }
  if (second !== undefined) return null;
  if (first === "capabilities" && wantsJson) return answerFor(await surface.negotiate(), true, () => "");
  if (first === "search" || (first === undefined && query !== "")) {
    const found = await surface.search({ text: query, limit: limitOf(url) });
    return answerFor(found, wantsJson, () => searchPage(query, found as PagedSearchResultsV2));
  }
  if (first !== undefined && first !== "pages") return null;
  const listed = await surface.listPage({ cursor: url.searchParams.get("cursor") ?? undefined, limit: limitOf(url) });
  return answerFor(listed, wantsJson, () => listingPage(listed as PagedListingV2));
}
