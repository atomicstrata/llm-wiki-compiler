/**
 * llmwiki viewer — vanilla-JS client.
 *
 * Three responsibilities, kept deliberately small:
 *   1. First paint from the server-embedded `<script type="application/json"
 *      id="page-index">` blob so the sidebar shows pages before any fetch.
 *   2. Full data from `/api/pages` once the page loads — replaces the
 *      first-paint sidebar with grouped concepts/queries, and renders
 *      the dashboard home.
 *   3. Hash router (`#/`, `#/concepts/<slug>`, `#/queries/<slug>`,
 *      `#/index`, `#/health`) that fetches `/api/page/...`,
 *      `/api/index`, or `/api/health` and drops the result into the
 *      main pane. The server returns already-sanitized HTML in `html`
 *      (see `src/viewer/render.ts`), so the client only has to set
 *      `innerHTML` and link up the support rail.
 *
 * No external dependencies, no client-side markdown rendering, no
 * inline event handlers — the spec's CSP only allows scripts from
 * `'self'`. The search-input wiring lives in `viewer-search.js`.
 */

import { wireSearch } from "./viewer-search.js";
import { renderSidebar, markActive } from "./viewer-sidebar.js";
import { renderProjectRail, renderSupportRail, clearSupportRail } from "./viewer-rail.js";
import { loadGraph } from "./viewer-graph.js";

const PAGE_INDEX_SELECTOR = "#page-index";
const MAIN_SELECTOR = "[data-main-pane]";
const TITLE_SELECTOR = "[data-app-title]";
const DEFAULT_TITLE = "llmwiki";
const EMPTY_INDEX = { pages: [] };

/** Hashes that all map to the home route — `#`, `#/`, and empty/missing. */
const HOME_HASHES = new Set(["", "#", "#/"]);

/** Static routes whose hash uniquely names the kind (no slug segment). */
const STATIC_ROUTES = new Map([
  ["#/index", { kind: "index" }],
  ["#/health", { kind: "health" }],
  ["#/graph", { kind: "graph" }],
]);

/** Pattern matching `#/(concepts|queries)/<slug>` hash routes. */
const PAGE_HASH_PATTERN = /^#\/(concepts|queries)\/(.+)$/;

/** Rows for the home dashboard counts grid: `[label, envelope.counts key]`. */
const COUNT_ROWS = [
  ["Concepts", "concepts"],
  ["Saved queries", "queries"],
  ["Source files", "sourceFiles"],
  ["Pending reviews", "pendingReviews"],
];

/** Rows for the /api/health metrics block: `[label, health key]`. */
const HEALTH_METRIC_ROWS = [
  ["Concepts", "concepts"],
  ["Saved queries", "queries"],
  ["Compiled sources", "sources"],
  ["Source files", "sourceFiles"],
  ["Pending reviews", "pendingReviews"],
];

/** Rows for the lint block: `[label, key, fallback]`. */
const LINT_METRIC_ROWS = [
  ["Warnings", "warnings", 0],
  ["Errors", "errors", 0],
  ["Last run", "at", ""],
];

/** Parse the server-embedded page-index JSON. Empty list if absent or malformed. */
function readEmbeddedIndex() {
  const node = document.querySelector(PAGE_INDEX_SELECTOR);
  const text = node?.textContent;
  if (!text) return EMPTY_INDEX;
  return parsePageIndex(text);
}

/** Best-effort JSON.parse of the embedded blob. Always returns a `{pages}` shape. */
function parsePageIndex(text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.pages)) return { pages: data.pages };
  } catch {
    // Malformed JSON in the embedded blob is not a user-facing error.
  }
  return EMPTY_INDEX;
}

/**
 * Parse `location.hash` into a route descriptor. Static routes resolve
 * via `STATIC_ROUTES`; page routes fall through to {@link parsePageRoute}.
 * Malformed percent-encoding in the slug segment falls back to the home
 * route so a hand-edited URL cannot throw from `decodeURIComponent`
 * (`#/concepts/%E0%A4%A` is the canonical bad-input case).
 */
function parseRoute(hash) {
  const key = hash ?? "";
  if (HOME_HASHES.has(key)) return { kind: "home" };
  const staticRoute = STATIC_ROUTES.get(key);
  if (staticRoute) return staticRoute;
  return parsePageRoute(key);
}

/** Resolve a `#/(concepts|queries)/<slug>` hash; non-matches return home. */
function parsePageRoute(hash) {
  const match = hash.match(PAGE_HASH_PATTERN);
  if (!match) return { kind: "home" };
  const slug = decodeSlug(match[2]);
  if (slug === null) return { kind: "home" };
  return { kind: "page", directory: match[1], slug };
}

/** Safely percent-decode a slug; returns null on malformed input. */
function decodeSlug(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Render the home dashboard from the `/api/pages` envelope. */
function renderHome(envelope) {
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.innerHTML = "";
  main.className = "main-pane home-dashboard";
  appendHomeContent(main, envelope);
  renderProjectRail(envelope);
}

/** Append every section of the home dashboard to the main pane. */
function appendHomeContent(main, envelope) {
  main.appendChild(buildHeading("h1", projectTitle(envelope)));
  main.appendChild(buildCountsBlock(envelope?.counts));
  appendIndexLinkIfAvailable(main, envelope);
  appendRecentBlockIfAny(main, envelope);
}

/** Append the compiled-index link, if the envelope flagged it available. */
function appendIndexLinkIfAvailable(main, envelope) {
  if (envelope?.index?.available) {
    main.appendChild(buildIndexLink(envelope.index.href));
  }
}

/** Append the recent-updates block, if the envelope carried any rows. */
function appendRecentBlockIfAny(main, envelope) {
  if (hasRecentPages(envelope)) {
    main.appendChild(buildRecentBlock(envelope.recentPages));
  }
}

/** Display title for the envelope, with a stable fallback. */
function projectTitle(envelope) {
  return envelope?.project?.title || DEFAULT_TITLE;
}

/** True when the envelope carries at least one recent page. */
function hasRecentPages(envelope) {
  return Array.isArray(envelope?.recentPages) && envelope.recentPages.length > 0;
}

/** Render a `<dl>` of project counts on the home dashboard. */
function buildCountsBlock(counts) {
  const rows = COUNT_ROWS.map(([label, key]) => [label, counts?.[key] ?? 0]);
  const dl = buildDefinitionList(rows);
  dl.className = "metric-grid";
  return dl;
}

/** Build a `<dl>` from a list of `[label, value]` rows. */
function buildDefinitionList(rows) {
  const dl = document.createElement("dl");
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "metric";
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    row.appendChild(dt);
    row.appendChild(dd);
    dl.appendChild(row);
  }
  return dl;
}

/** Build the link that takes the user to the compiled wiki/index.md page. */
function buildIndexLink(href) {
  const p = document.createElement("p");
  p.className = "home-action";
  const a = document.createElement("a");
  a.href = href;
  a.textContent = "Browse the compiled index →";
  p.appendChild(a);
  return p;
}

/** Render the recent-pages list on the home dashboard. */
function buildRecentBlock(recent) {
  const ul = document.createElement("ul");
  ul.className = "recent-list";
  for (const page of recent) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
    a.textContent = page.title || page.slug;
    li.appendChild(a);
    ul.appendChild(li);
  }
  const wrap = document.createElement("section");
  wrap.className = "recent-section";
  wrap.appendChild(buildHeading("h2", "Recently updated"));
  wrap.appendChild(ul);
  return wrap;
}

/** Build a heading element with the given tag and text content. */
function buildHeading(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

/** Build a `<p class="placeholder">` with the given message. */
function buildPlaceholder(text) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = text;
  return p;
}

/** Dispatch table: route.kind → handler for routes that fit the (main) signature. */
const ROUTE_RENDERERS = {
  home: () => loadAndRenderHome(),
  index: (main) => renderIndexPane(main),
  health: (main) => renderHealthPane(main),
  graph: (main) => renderGraphPane(main),
};

/** Fetch and render the page at the current hash route. */
async function renderRoute() {
  const route = parseRoute(location.hash);
  markActive();
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.className = "main-pane";
  const handler = ROUTE_RENDERERS[route.kind];
  if (handler) return handler(main);
  return renderPagePane(main, route.directory, route.slug);
}

/** Fetch /api/health and render the dashboard. */
async function renderHealthPane(main) {
  try {
    const health = await fetchJson("/api/health");
    main.innerHTML = "";
    main.appendChild(buildHeading("h1", "Health"));
    main.appendChild(buildHealthDashboard(health));
    clearSupportRail();
  } catch (err) {
    renderError(`Could not load /api/health: ${err.message}`);
  }
}

/** Build the health dashboard DOM from the `/api/health` payload. */
function buildHealthDashboard(health) {
  const wrap = document.createElement("section");
  wrap.className = "health-dashboard";
  const rows = HEALTH_METRIC_ROWS.map(([label, key]) => [label, health?.[key] ?? 0]);
  const metrics = buildDefinitionList(rows);
  metrics.className = "metric-list";
  wrap.appendChild(metrics);
  wrap.appendChild(buildLintBlock(health?.lint));
  return wrap;
}

/** Render the lint summary, or a "lint has not been run yet" placeholder. */
function buildLintBlock(lint) {
  const wrap = document.createElement("section");
  wrap.appendChild(buildHeading("h2", "Lint"));
  if (!lint) {
    wrap.appendChild(buildPlaceholder("No cached lint summary yet — run `llmwiki lint`."));
    return wrap;
  }
  const rows = LINT_METRIC_ROWS.map(([label, key, fallback]) => [label, lint[key] ?? fallback]);
  wrap.appendChild(buildDefinitionList(rows));
  return wrap;
}

/** Fetch /api/pages and render the dashboard. */
async function loadAndRenderHome() {
  try {
    const envelope = await fetchJson("/api/pages");
    applyHomeEnvelope(envelope);
  } catch (err) {
    renderError(`Could not load /api/pages: ${err.message}`);
  }
}

/** Apply a successfully fetched /api/pages envelope to the chrome + main pane. */
function applyHomeEnvelope(envelope) {
  const titleEl = document.querySelector(TITLE_SELECTOR);
  titleEl.textContent = projectTitle(envelope);
  renderSidebar(envelope?.pages || []);
  renderHome(envelope);
}

/** Fetch /api/index and render the rendered HTML coming back from the server. */
async function renderIndexPane(main) {
  clearSupportRail();
  try {
    const payload = await fetchJson("/api/index");
    main.innerHTML = "";
    main.appendChild(buildHeading("h1", "Index"));
    appendRenderedBody(main, payload.html);
  } catch (err) {
    handleIndexError(main, err);
  }
}

/** Render either the "wiki/index.md missing" placeholder or a generic error. */
function handleIndexError(main, err) {
  if (err.status !== 404) {
    renderError(`Could not load /api/index: ${err.message}`);
    return;
  }
  main.innerHTML = "";
  main.appendChild(buildPlaceholder("wiki/index.md is not available. Run `llmwiki compile`."));
}

/** Fetch /api/page/:dir/:slug and render. */
async function renderPagePane(main, directory, slug) {
  try {
    const payload = await fetchJson(pageApiPath(directory, slug));
    renderPagePayload(main, payload, slug);
  } catch (err) {
    handlePageError(main, err, directory, slug);
  }
}

/** Build the `/api/page/:dir/:slug` URL with both segments percent-encoded. */
function pageApiPath(directory, slug) {
  return `/api/page/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`;
}

/** Render the body of a successful /api/page response into the main pane. */
function renderPagePayload(main, payload, slug) {
  const title = payload.title || slug;
  main.innerHTML = "";
  main.appendChild(buildHeading("h1", title));
  if (payload.pageDirectory === "queries") {
    main.appendChild(buildQueryQuestion(title));
  }
  appendWarnings(main, payload.warnings || []);
  const body = appendRenderedBody(main, payload.html);
  removeDuplicateLeadingHeading(body, title);
  renderSupportRail(payload);
}

/** Question banner shown above the body for saved-query pages. */
function buildQueryQuestion(title) {
  const p = document.createElement("p");
  p.className = "query-question";
  p.textContent = `Question: ${title}`;
  return p;
}

/** Render the 404 placeholder or a generic error for /api/page failures. */
function handlePageError(main, err, directory, slug) {
  if (err.status !== 404) {
    renderError(`Could not load page: ${err.message}`);
    return;
  }
  main.innerHTML = "";
  main.appendChild(buildPlaceholder(`Page not found: ${directory}/${slug}`));
  clearSupportRail();
}

/**
 * Append the server-sanitized HTML body to `main`. The server always
 * returns sanitized markup in `payload.html` (see Slice 4 — `src/viewer/
 * render.ts`), so the client only sets `innerHTML` on a wrapper. Empty
 * `html` means the page had no body after the frontmatter block;
 * surface a visible "no content" placeholder rather than rendering an
 * empty pane.
 */
function appendRenderedBody(main, html) {
  if (typeof html === "string" && html.length > 0) {
    const body = document.createElement("div");
    body.className = "rendered-body";
    body.innerHTML = html;
    main.appendChild(body);
    return body;
  }
  const note = buildPlaceholder("No rendered content.");
  main.appendChild(note);
  return note;
}

/** Drop a duplicated first Markdown H1 when it matches the viewer page title. */
function removeDuplicateLeadingHeading(body, title) {
  const heading = leadingH1(body);
  if (!heading) return;
  if (!hasMatchingHeadingText(heading, title)) return;
  heading.remove();
}

/** Return `body.firstElementChild` if it is an H1, else null. */
function leadingH1(body) {
  const first = body?.firstElementChild;
  if (!first) return null;
  return first.tagName === "H1" ? first : null;
}

/** True when the heading text matches `title` after trimming both sides. */
function hasMatchingHeadingText(heading, title) {
  if (!title) return false;
  const headingText = heading.textContent?.trim();
  return headingText === title.trim();
}

/** Render every payload warning as a banner above the page body. */
function appendWarnings(main, warnings) {
  for (const w of warnings) {
    const banner = document.createElement("div");
    banner.className = "warning-banner";
    banner.textContent = w.message || w.code;
    main.appendChild(banner);
  }
}

/** Render a top-of-main error banner without crashing the rest of the UI. */
function renderError(message) {
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.innerHTML = "";
  const banner = document.createElement("div");
  banner.className = "warning-banner";
  banner.textContent = message;
  main.appendChild(banner);
  clearSupportRail();
}

/** Fetch /api/graph and render the force-directed graph view. */
async function renderGraphPane(main) {
  clearSupportRail();
  main.innerHTML = "";
  main.className = "main-pane graph-pane";
  await loadGraph(main);
}

/** Promise-returning fetch helper that surfaces non-2xx statuses as errors. */
async function fetchJson(pathname) {
  const res = await fetch(pathname, { credentials: "same-origin" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Bootstrap: first-paint from embedded blob, then full fetch + router. */
function main() {
  const embedded = readEmbeddedIndex();
  renderSidebar(embedded.pages);
  wireSearch({ fetchJson });
  window.addEventListener("hashchange", () => {
    void renderRoute();
  });
  void renderRoute();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
