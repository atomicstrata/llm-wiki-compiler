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

/** Parse the server-embedded page-index JSON. Empty list if absent or malformed. */
function readEmbeddedIndex() {
  const node = document.querySelector(PAGE_INDEX_SELECTOR);
  if (!node || !node.textContent) return { pages: [] };
  try {
    const data = JSON.parse(node.textContent);
    return Array.isArray(data?.pages) ? { pages: data.pages } : { pages: [] };
  } catch {
    return { pages: [] };
  }
}


/**
 * Parse `location.hash` into a route descriptor. Malformed percent-
 * encoding in the slug segment falls back to the home route so a typo
 * or hand-edited URL cannot throw from `decodeURIComponent` and crash
 * the client (`#/concepts/%E0%A4%A` is the canonical bad-input case).
 */
function parseRoute(hash) {
  if (!hash || hash === "#" || hash === "#/" || hash === "") return { kind: "home" };
  if (hash === "#/index") return { kind: "index" };
  if (hash === "#/health") return { kind: "health" };
  if (hash === "#/graph") return { kind: "graph" };
  const match = hash.match(/^#\/(concepts|queries)\/(.+)$/);
  if (!match) return { kind: "home" };
  let slug;
  try {
    slug = decodeURIComponent(match[2]);
  } catch {
    return { kind: "home" };
  }
  return { kind: "page", directory: match[1], slug };
}

/** Render the home dashboard from the `/api/pages` envelope. */
function renderHome(envelope) {
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.innerHTML = "";
  main.className = "main-pane home-dashboard";
  const title = document.createElement("h1");
  title.textContent = envelope.project?.title || "llmwiki";
  main.appendChild(title);
  main.appendChild(buildCountsBlock(envelope.counts || {}));
  if (envelope.index?.available) main.appendChild(buildIndexLink(envelope.index.href));
  if (Array.isArray(envelope.recentPages) && envelope.recentPages.length > 0) {
    main.appendChild(buildRecentBlock(envelope.recentPages));
  }
  renderProjectRail(envelope);
}

/** Render a `<dl>` of project counts on the home dashboard. */
function buildCountsBlock(counts) {
  const dl = buildDefinitionList([
    ["Concepts", counts.concepts ?? 0],
    ["Saved queries", counts.queries ?? 0],
    ["Source files", counts.sourceFiles ?? 0],
    ["Pending reviews", counts.pendingReviews ?? 0],
  ]);
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
  const h2 = document.createElement("h2");
  h2.textContent = "Recently updated";
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
  wrap.appendChild(h2);
  wrap.appendChild(ul);
  return wrap;
}

/** Fetch and render the page at the current hash route. */
async function renderRoute() {
  const route = parseRoute(location.hash);
  markActive();
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.className = "main-pane";
  if (route.kind === "home") return loadAndRenderHome();
  if (route.kind === "index") return renderIndexPane(main);
  if (route.kind === "health") return renderHealthPane(main);
  if (route.kind === "graph") return renderGraphPane(main);
  return renderPagePane(main, route.directory, route.slug);
}

/** Fetch /api/health and render the dashboard. */
async function renderHealthPane(main) {
  try {
    const health = await fetchJson("/api/health");
    main.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = "Health";
    main.appendChild(h1);
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
  const metrics = buildDefinitionList([
    ["Concepts", health.concepts ?? 0],
    ["Saved queries", health.queries ?? 0],
    ["Compiled sources", health.sources ?? 0],
    ["Source files", health.sourceFiles ?? 0],
    ["Pending reviews", health.pendingReviews ?? 0],
  ]);
  metrics.className = "metric-list";
  wrap.appendChild(metrics);
  wrap.appendChild(buildLintBlock(health.lint));
  return wrap;
}

/** Render the lint summary, or a "lint has not been run yet" placeholder. */
function buildLintBlock(lint) {
  const wrap = document.createElement("section");
  const h2 = document.createElement("h2");
  h2.textContent = "Lint";
  wrap.appendChild(h2);
  if (!lint) {
    const note = document.createElement("p");
    note.className = "placeholder";
    note.textContent = "No cached lint summary yet — run `llmwiki lint`.";
    wrap.appendChild(note);
    return wrap;
  }
  wrap.appendChild(buildDefinitionList([
    ["Warnings", lint.warnings ?? 0],
    ["Errors", lint.errors ?? 0],
    ["Last run", lint.at ?? ""],
  ]));
  return wrap;
}

/** Fetch /api/pages and render the dashboard. */
async function loadAndRenderHome() {
  try {
    const envelope = await fetchJson("/api/pages");
    document.querySelector(TITLE_SELECTOR).textContent = envelope.project?.title || "llmwiki";
    renderSidebar(envelope.pages || []);
    renderHome(envelope);
  } catch (err) {
    renderError(`Could not load /api/pages: ${err.message}`);
  }
}

/** Fetch /api/index and render the rendered HTML coming back from the server. */
async function renderIndexPane(main) {
  clearSupportRail();
  try {
    const payload = await fetchJson("/api/index");
    main.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = "Index";
    main.appendChild(h1);
    appendRenderedBody(main, payload.html);
  } catch (err) {
    if (err.status === 404) {
      main.innerHTML = "";
      const note = document.createElement("p");
      note.className = "placeholder";
      note.textContent = "wiki/index.md is not available. Run `llmwiki compile`.";
      main.appendChild(note);
    } else {
      renderError(`Could not load /api/index: ${err.message}`);
    }
  }
}

/** Fetch /api/page/:dir/:slug and render. */
async function renderPagePane(main, directory, slug) {
  try {
    const payload = await fetchJson(
      `/api/page/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`,
    );
    main.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = payload.title || slug;
    main.appendChild(h1);
    if (payload.pageDirectory === "queries") {
      const question = document.createElement("p");
      question.className = "query-question";
      question.textContent = `Question: ${payload.title || slug}`;
      main.appendChild(question);
    }
    appendWarnings(main, payload.warnings || []);
    const body = appendRenderedBody(main, payload.html);
    removeDuplicateLeadingHeading(body, payload.title || slug);
    renderSupportRail(payload);
  } catch (err) {
    if (err.status === 404) {
      main.innerHTML = "";
      const note = document.createElement("p");
      note.className = "placeholder";
      note.textContent = `Page not found: ${directory}/${slug}`;
      main.appendChild(note);
      clearSupportRail();
    } else {
      renderError(`Could not load page: ${err.message}`);
    }
  }
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
  const note = emptyBodyNote();
  main.appendChild(note);
  return note;
}

/** Drop a duplicated first Markdown H1 when it matches the viewer page title. */
function removeDuplicateLeadingHeading(body, title) {
  if (!body || !title) return;
  const first = body.firstElementChild;
  if (!first || first.tagName !== "H1") return;
  if (first.textContent?.trim() !== title.trim()) return;
  first.remove();
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

/** Visible "no content" fallback for pages whose body is empty after frontmatter. */
function emptyBodyNote() {
  const note = document.createElement("p");
  note.className = "placeholder";
  note.textContent = "No rendered content.";
  return note;
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
