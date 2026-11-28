/**
 * @file src/portable/surfaces/viewer-html.ts
 * @description The portable viewer's pages: plain, server-rendered,
 * read-only HTML for inspecting a portable project.
 *
 * It shows published pages, keyword search, and — for review — a proposal's
 * candidates with the EXACT draft that would be written, what it would
 * replace, and the digests an approval must name. It ends each review page
 * with the command to run next, because this viewer cannot approve or apply:
 * it has no form that changes anything and no script at all.
 *
 * Everything from a project is treated as untrusted text. It is escaped and
 * shown preformatted; nothing here interprets Markdown or HTML. This is a
 * prototype inspection surface, not the legacy viewer and not at parity with it.
 */

import type { CandidateSummary } from "../contracts.js";
import type { CandidateView, Listed, PageListing, PageView, SearchHit } from "../project/api.js";

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ESCAPES[character]);
}

/** Wrap a body in the viewer's page shell. */
function shell(title: string, body: string, notice: string): string {
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} · llmwiki portable viewer</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}",
    "pre{white-space:pre-wrap;border:1px solid #ccc;padding:1rem}code{word-break:break-all}</style>",
    "</head>", "<body>",
    '<p><a href="/">Pages</a> · read-only portable viewer (prototype)</p>',
    `<h1>${escapeHtml(title)}</h1>`, body, `<p><small>${escapeHtml(notice)}</small></p>`,
    "</body>", "</html>",
  ].join("\n");
}

/** A list of links, or a line saying there is nothing to show. */
function linkList(items: readonly { href: string; label: string }[]): string {
  if (items.length === 0) return "<p>Nothing to show.</p>";
  const rows = items.map(({ href, label }) => `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`);
  return `<ul>${rows.join("")}</ul>`;
}

/** The home page: a search box and the page list, or search results. */
export function homePage(listed: Listed<PageListing | SearchHit>, query: string): string {
  const form = `<form method="get" action="/"><input name="q" value="${escapeHtml(query)}" aria-label="Search">`
    + "<button>Search</button></form>";
  const items = listed.items.map((item) => ({ href: `/pages/${encodeURIComponent(item.id)}`, label: item.title }));
  return shell(query ? `Search: ${query}` : "Pages", form + linkList(items), listed.notice);
}

/** One published page, shown as the exact text that is stored. */
export function pagePage(page: PageView, notice: string): string {
  const body = `<p>Digest <code>${escapeHtml(page.digest)}</code></p><pre>${escapeHtml(page.body)}</pre>`;
  return shell(page.id, body, notice);
}

/** A proposal's candidates. */
export function proposalPage(proposal: string, listed: Listed<CandidateSummary>): string {
  const items = listed.items.map((item) => ({
    href: `/proposals/${encodeURIComponent(proposal)}/candidates/${encodeURIComponent(item.id)}`,
    label: `${item.id} → ${item.targetPath}`,
  }));
  return shell(`Proposal ${proposal}`, linkList(items), listed.notice);
}

/** The command a reviewer runs next. The viewer cannot run it for them. */
function approveHandoff(view: CandidateView): string {
  return [
    `llmwiki project approve ${view.proposalOperationId}`,
    `  --candidate-set ${view.candidateSetDigest}`,
    `  --plan ${view.planDigest}`,
    `  --dependencies ${view.applyDependenciesDigest}`,
    "  --project <ref>",
  ].join(" \\\n");
}

/** One candidate: the exact draft, what it replaces, and the approval handoff. */
export function candidatePage(view: CandidateView, notice: string): string {
  const replaces = view.targetPre.state === "absent"
    ? "Creates a new page."
    : `Replaces the version with digest <code>${escapeHtml(view.targetPre.digest)}</code>.`;
  const body = [
    `<p>Target <code>${escapeHtml(view.targetPath)}</code>. ${replaces}</p>`,
    `<p>Draft digest <code>${escapeHtml(view.draftDigest)}</code></p>`,
    "<h2>Exact draft that would be written</h2>", `<pre>${escapeHtml(view.draftBody)}</pre>`,
    "<h2>To approve exactly this</h2>",
    "<p>This viewer cannot approve or apply. Run:</p>", `<pre>${escapeHtml(approveHandoff(view))}</pre>`,
  ].join("\n");
  return shell(`Candidate ${view.id}`, body, notice);
}

/** The page shown for anything absent, denied or not understood. One answer for all three. */
export function notFoundPage(): string {
  return shell("Not found", "<p>There is nothing here that you can see.</p>", "Results reflect your access");
}
