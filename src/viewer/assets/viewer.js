/**
 * llmwiki viewer — vanilla-JS client.
 *
 * Three responsibilities, kept deliberately small:
 *   1. First paint from the server-embedded `<script type="application/json"
 *      id="page-index">` blob so the sidebar shows pages before any fetch.
 *   2. Full data from `/api/pages` once the page loads — replaces the
 *      first-paint sidebar with grouped concepts/queries, and renders the
 *      dashboard home.
 *   3. Hash router (`#/`, `#/concepts/<slug>`, `#/queries/<slug>`,
 *      `#/index`) that fetches `/api/page/...` or `/api/index` and
 *      drops the result into the main pane. Slice 4 swaps the
 *      `render_pending` placeholder for real sanitized HTML.
 *
 * No external dependencies, no client-side markdown rendering, no inline
 * event handlers — the spec's CSP only allows scripts from `'self'`.
 */

const PAGE_INDEX_SELECTOR = "#page-index";
const SIDEBAR_SELECTOR = "[data-sidebar]";
const MAIN_SELECTOR = "[data-main-pane]";
const SUPPORT_SELECTOR = "[data-support-rail]";
const TITLE_SELECTOR = "[data-app-title]";

const SUPPORT_FIELDS = ["kind", "summary", "createdAt", "updatedAt"];

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

/** Render the sidebar from a list of page summaries (no fetch). */
function renderSidebar(pages) {
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (!sidebar) return;
  sidebar.innerHTML = "";
  const concepts = pages.filter((p) => p.pageDirectory === "concepts");
  const queries = pages.filter((p) => p.pageDirectory === "queries");
  if (concepts.length > 0) sidebar.appendChild(buildGroup("Concepts", concepts));
  if (queries.length > 0) sidebar.appendChild(buildGroup("Saved Queries", queries));
  if (concepts.length === 0 && queries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No pages yet — run `llmwiki compile`.";
    sidebar.appendChild(empty);
  }
  markActive();
}

/** Build a sidebar group (heading + flat list of links). */
function buildGroup(label, pages) {
  const wrap = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = label;
  wrap.appendChild(heading);
  const list = document.createElement("ul");
  for (const page of pages) {
    const item = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
    a.dataset.pageId = page.id;
    a.textContent = page.title || page.slug;
    item.appendChild(a);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

/** Mark the sidebar entry matching the current hash route as `aria-current`. */
function markActive() {
  const current = parseRoute(location.hash);
  const links = document.querySelectorAll(`${SIDEBAR_SELECTOR} a`);
  for (const link of links) link.removeAttribute("aria-current");
  if (current.kind !== "page") return;
  const expectedId = `${current.directory}/${current.slug}`;
  for (const link of links) {
    if (link.dataset.pageId === expectedId) {
      link.setAttribute("aria-current", "page");
      return;
    }
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
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!main) return;
  main.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = envelope.project?.title || "llmwiki";
  main.appendChild(title);
  main.appendChild(buildCountsBlock(envelope.counts || {}));
  if (envelope.index?.available) main.appendChild(buildIndexLink(envelope.index.href));
  if (Array.isArray(envelope.recentPages) && envelope.recentPages.length > 0) {
    main.appendChild(buildRecentBlock(envelope.recentPages));
  }
  if (support) support.innerHTML = "";
}

/** Render a `<dl>` of project counts on the home dashboard. */
function buildCountsBlock(counts) {
  const list = document.createElement("dl");
  const rows = [
    ["Concepts", counts.concepts ?? 0],
    ["Saved queries", counts.queries ?? 0],
    ["Source files", counts.sourceFiles ?? 0],
    ["Pending reviews", counts.pendingReviews ?? 0],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    list.appendChild(dt);
    list.appendChild(dd);
  }
  return list;
}

/** Build the link that takes the user to the compiled wiki/index.md page. */
function buildIndexLink(href) {
  const p = document.createElement("p");
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
  for (const page of recent) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
    a.textContent = page.title || page.slug;
    li.appendChild(a);
    ul.appendChild(li);
  }
  const wrap = document.createElement("section");
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
  if (route.kind === "home") return loadAndRenderHome();
  if (route.kind === "index") return renderIndexPane(main);
  return renderPagePane(main, route.directory, route.slug);
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

/** Fetch /api/index and render. In Slice 3 the html is still empty; show the placeholder. */
async function renderIndexPane(main) {
  try {
    const payload = await fetchJson("/api/index");
    main.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = "Index";
    main.appendChild(h1);
    appendRenderedBody(main, payload.html, true);
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
    appendRenderedBody(main, payload.html, hasRenderPending(payload.warnings));
    renderSupportRail(payload);
  } catch (err) {
    if (err.status === 404) {
      main.innerHTML = "";
      const note = document.createElement("p");
      note.className = "placeholder";
      note.textContent = `Page not found: ${directory}/${slug}`;
      main.appendChild(note);
    } else {
      renderError(`Could not load page: ${err.message}`);
    }
  }
}

/**
 * Append the rendered page body to `main`. When `html` is empty, show
 * the Slice-4 "rendering pending" placeholder if `fallbackToPending` is
 * true; otherwise render nothing extra. Slice 4 will replace this code
 * path with the sanitized HTML coming from the server, so the same
 * helper continues to work then.
 */
function appendRenderedBody(main, html, fallbackToPending) {
  if (typeof html === "string" && html.length > 0) {
    const body = document.createElement("div");
    body.innerHTML = html;
    main.appendChild(body);
  } else if (fallbackToPending) {
    main.appendChild(renderingPendingNote());
  }
}

/** Render warnings as a list of banners above the page body. */
function appendWarnings(main, warnings) {
  for (const w of warnings) {
    if (w.code === "render_pending") continue;
    const banner = document.createElement("div");
    banner.className = "warning-banner";
    banner.textContent = w.message || w.code;
    main.appendChild(banner);
  }
}

/** True when a warnings array contains the Slice-2 render-pending placeholder. */
function hasRenderPending(warnings) {
  if (!Array.isArray(warnings)) return false;
  return warnings.some((w) => w?.code === "render_pending");
}

/** Visible "rendering ships in Slice 4" placeholder for empty `html` payloads. */
function renderingPendingNote() {
  const note = document.createElement("p");
  note.className = "placeholder";
  note.textContent = "Page rendering ships in Slice 4.";
  return note;
}

/** Populate the right-hand support rail with page metadata. */
function renderSupportRail(payload) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  const dl = document.createElement("dl");
  const meta = payload.frontmatter || {};
  for (const key of SUPPORT_FIELDS) {
    const value = meta[key];
    if (value === undefined || value === null || value === "") continue;
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  support.appendChild(dl);
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
