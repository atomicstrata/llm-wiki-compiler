/**
 * llmwiki viewer — vanilla-JS client.
 *
 * Three responsibilities, kept deliberately small:
 *   1. First paint renders the sidebar nav from an empty model
 *      (`renderSidebar({})`) so the chrome appears before any fetch settles.
 *      The server embeds no page data in the shell, so this is the only first
 *      paint there is — see `src/viewer/shell.ts`.
 *   2. `/api/pages` and `/api/health`, fetched once in parallel via
 *      `loadBootstrapData()` and cached in `bootstrapData` — fill in the
 *      sidebar's counts and lint badge, the header's whole-wiki verdict
 *      pill (which reads both), and render the dashboard home.
 *   3. Hash router. Home is `#/`; a page is `#/<directory>/<slug>`, where
 *      directory is `concepts`, `queries`, or any entity type the active
 *      profile declares; a profile type's list is `#/_type/<entity-type>`; and
 *      the static routes are `#/index`, `#/health`, `#/graph`, `#/concepts`,
 *      `#/queries`, `#/sources`, `#/reviews`, `#/workflows` and `#/pipeline`
 *      (the full set is {@link STATIC_ROUTES} — this list and that map are the
 *      same nine). Routes fetch `/api/page/...`, `/api/index`, `/api/health`,
 *      `/api/reviews` or `/api/workflow-runs`; the four list routes and the
 *      graph read the already-fetched bootstrap envelope and issue nothing of
 *      their own. The server returns already-sanitized HTML in `html` (see
 *      `src/viewer/render.ts`), so the client only has to set `innerHTML`
 *      and link up the support rail.
 *
 * No external dependencies, no client-side markdown rendering, no
 * inline event handlers — the spec's CSP only allows scripts from
 * `'self'`. The search-input wiring lives in `viewer-search.js`.
 */

import { el, heading, placeholder } from "./viewer-dom.js";
import { wireThemeToggle } from "./viewer-theme.js";
import { wireSearch } from "./viewer-search.js";
import { renderSidebar, markActive } from "./viewer-sidebar.js";
import { renderSupportRail, clearSupportRail } from "./viewer-rail.js";
import { loadGraph, staleIdsFromEnvelope } from "./viewer-graph.js";
import { renderHeader } from "./viewer-header.js";
import {
  renderConceptsList,
  renderEntityTypeList,
  renderQueriesList,
  renderSourcesList,
} from "./viewer-lists.js";
import { renderReviewsList } from "./viewer-reviews.js";
import { renderWorkflowRunsList } from "./viewer-workflows.js";
import { renderPipeline } from "./viewer-pipeline.js";
import { renderDashboard } from "./viewer-dashboard.js";
import { buildHealthView } from "./viewer-health.js";
import { typeListHashType } from "./viewer-routes.js";

const MAIN_SELECTOR = "[data-main-pane]";

/** Hashes that all map to the home route — `#`, `#/`, and empty/missing. */
const HOME_HASHES = new Set(["", "#", "#/"]);

/** Static routes whose hash uniquely names the kind (no slug segment). */
const STATIC_ROUTES = new Map([
  ["#/index", { kind: "index" }],
  ["#/health", { kind: "health" }],
  ["#/graph", { kind: "graph" }],
  ["#/concepts", { kind: "concepts" }],
  ["#/queries", { kind: "queries" }],
  ["#/sources", { kind: "sources" }],
  ["#/reviews", { kind: "reviews" }],
  ["#/workflows", { kind: "workflows" }],
  ["#/pipeline", { kind: "pipeline" }],
]);

/**
 * Pattern matching a `#/<directory>/<slug>` page hash.
 *
 * The directory is deliberately NOT an enumeration here. A profile project's
 * entity types are addressable page directories too (`#/articles/<slug>`), and
 * that set is per-project — so hardcoding one would make every typed page a
 * dead link, which is precisely what it did before `/api/page` learned to serve
 * them. The authoritative allowlist lives on the server, derived from the active
 * profile (see `isAllowedDirectory`, src/viewer/api-pages.ts); an unknown
 * directory is rejected there and surfaces through {@link handlePageError}.
 *
 * Resolving here rather than against the bootstrap envelope keeps a cold deep
 * link working: opening `#/articles/x` in a fresh tab must route before
 * `/api/pages` has settled.
 *
 * Single-segment hashes never reach this pattern — STATIC_ROUTES is consulted
 * first, and an unmatched one still falls back to home. A NAMESPACED list hash
 * (`#/_type/articles`) does match it, which is why the order in
 * {@link parseRoute} is load-bearing; see {@link namedRoute}.
 */
const PAGE_HASH_PATTERN = /^#\/([^/]+)\/(.+)$/;

/**
 * Bootstrap payloads shared by the sidebar, dashboard, and health route.
 * Fetched once in parallel at startup; each entry stays null if its fetch
 * failed, so one failing endpoint degrades only the surfaces that need it.
 */
const bootstrapData = { pages: null, health: null, settled: false };

/** Fetch both bootstrap endpoints in parallel, tolerating either failing. */
async function loadBootstrapData() {
  const [pages, health] = await Promise.all([
    fetchJson("/api/pages").catch(() => null),
    fetchJson("/api/health").catch(() => null),
  ]);
  bootstrapData.pages = pages;
  bootstrapData.health = health;
  // Distinct from `pages !== null`: a FAILED fetch has also settled, and the
  // router must stop waiting on an answer that is never coming.
  bootstrapData.settled = true;
  return bootstrapData;
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
  return namedRoute(key) ?? unsettledOrPageRoute(key);
}

/**
 * A route the hash names outright: the fixed table first, then the typed list
 * routes the active profile contributes. Returns undefined when the hash names
 * neither, leaving the page-route path to answer.
 *
 * THE ORDER HERE IS LOAD-BEARING. A namespaced list hash is two segments, so
 * `#/_type/articles` matches PAGE_HASH_PATTERN as readily as it matches the
 * namespace. Resolving the page pattern first would fetch
 * `/api/page/_type/articles`, take the 400 the server owes an undeclared
 * directory, and paint "Page not found" over a route that exists — so the
 * namespace is consulted before {@link parsePageRoute} ever sees the hash.
 */
function namedRoute(key) {
  return STATIC_ROUTES.get(key) ?? entityListRoute(key);
}

/**
 * A namespaced list hash whose type the envelope has not yet classified.
 *
 * `renderRoute` runs once before /api/pages settles and again after, so a cold
 * deep link to `#/_type/articles` reaches the first pass with no entity types
 * known. Falling back to home THERE is not merely a wrong first frame: the home
 * render is async and lands after the corrected second pass, overwriting the
 * list it just drew. Holding the route instead means the first pass paints
 * nothing and the second pass paints once, whichever way it resolves.
 *
 * Only the namespace waits, and nothing in it is ever a page route: `_type` is
 * not a name a profile can declare (see viewer-routes.js), so an undeclared type
 * goes home rather than to a page fetch that could only 400. A page route
 * (`#/articles/alpha`) resolves without the envelope and never waits.
 */
function unsettledOrPageRoute(key) {
  const namespaced = typeListHashType(key) !== null;
  if (namespaced && !bootstrapData.settled) return { kind: "pending" };
  if (namespaced) return { kind: "home" };
  return parsePageRoute(key);
}

/**
 * Resolve `#/_type/<entity-type>` — a profile's typed list route.
 *
 * Entity types are per-project, so this cannot join STATIC_ROUTES: the match is
 * against what the ENVELOPE declares. Only a declared type resolves, which is
 * what keeps `#/_type/nonsense` falling back to home — the same fallback that
 * catches `#/nonsense`, and the one the nav-integrity guard
 * (test/viewer-sidebar-nav.test.ts) relies on to tell a real route from a dead
 * href.
 */
function entityListRoute(key) {
  const type = typeListHashType(key);
  if (type === null || !declaredEntityTypes().includes(type)) return null;
  return { kind: "entityList", type };
}

/** The envelope's declared entity-type rows, or an empty list before it settles. */
function declaredTypeRows() {
  const entityTypes = bootstrapData.pages?.profilePipeline?.entityTypes;
  return Array.isArray(entityTypes) ? entityTypes : [];
}

/** The entity type ids the cached envelope declares; empty until it settles. */
function declaredEntityTypes() {
  return declaredTypeRows().map((entry) => entry?.type);
}

/** Resolve a `#/<directory>/<slug>` hash; non-matches return home. */
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

/** Dispatch table: route.kind → handler for routes that fit the (main) signature. */
const ROUTE_RENDERERS = {
  home: () => loadAndRenderHome(),
  // Deliberately paints nothing — see `unsettledOrPageRoute`.
  pending: () => undefined,
  index: (main) => renderIndexPane(main),
  health: (main) => renderHealthPane(main),
  graph: (main) => renderGraphPane(main),
  concepts: (main) => renderListRoute(main, renderConceptsList),
  queries: (main) => renderListRoute(main, renderQueriesList),
  sources: (main) => renderListRoute(main, renderSourcesList),
  reviews: (main) => renderFetchedRoute(main, "/api/reviews", renderReviewsList),
  workflows: (main) => renderFetchedRoute(main, "/api/workflow-runs", renderWorkflowRunsList),
  pipeline: (main) => renderListRoute(main, renderPipeline),
};

/**
 * Fetch one endpoint and hand its payload to `render`. Unlike the list routes
 * above, these routes fetch per VISIT rather than reading the cached bootstrap
 * envelope: review candidates live under `.llmwiki/candidates/` and workflow
 * runs under `.llmwiki/workflows/runs/`, both outside the frozen snapshot, and
 * both endpoints are kept off the bootstrap path so every other route stays as
 * cheap as it was.
 */
async function renderFetchedRoute(main, endpoint, render) {
  clearSupportRail();
  try {
    render(main, await fetchJson(endpoint));
  } catch (err) {
    renderError(`Could not load ${endpoint}: ${err.message}`);
  }
}

/** Render a list route from the cached envelope, fetching only if absent. */
async function renderListRoute(main, render) {
  clearSupportRail();
  const envelope = bootstrapData.pages ?? (await loadBootstrapData()).pages;
  if (!envelope) {
    renderError("Could not load /api/pages");
    return;
  }
  render(main, envelope);
}

/** Fetch and render the page at the current hash route. */
async function renderRoute() {
  const route = parseRoute(location.hash);
  markActive();
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.className = "main-pane";
  // Not in ROUTE_RENDERERS: every entry there is keyed by kind alone, and this
  // route needs the type the hash named as well.
  if (route.kind === "entityList") return renderEntityListRoute(main, route.type);
  const handler = ROUTE_RENDERERS[route.kind];
  if (handler) return handler(main);
  return renderPagePane(main, route.directory, route.slug);
}

/** Render one entity type's list from the cached envelope. */
function renderEntityListRoute(main, type) {
  return renderListRoute(main, (pane, envelope) => renderEntityTypeList(pane, envelope, type));
}

/**
 * Render the health pane from the cached payloads, fetching only if absent.
 * Both are needed: `/api/health` carries the counts and the lint cache,
 * `/api/pages` the per-page freshness and citation totals the right-hand
 * column projects. `health-pane` opts the pane out of `.main-pane`'s
 * prose-width cap so the two-column grid gets the full content width.
 */
async function renderHealthPane(main) {
  const data = bootstrapData.health ? bootstrapData : await loadBootstrapData();
  if (!data.health) {
    renderError("Could not load /api/health");
    return;
  }
  main.className = "main-pane health-pane";
  main.innerHTML = "";
  // The global banner (injected at bootstrap) covers every route including health;
  // only add it here if bootstrap didn't already inject one (e.g. if /api/pages
  // was not yet fetched when navigating directly to #/health).
  prependBannerIfNeeded(main, data.health.stateStatus);
  main.appendChild(buildHealthView(data.health, data.pages));
  clearSupportRail();
}

/** state.json classifications that surface a user-visible warning banner. */
const BANNER_STATE_STATUSES = new Set(["corrupt", "too-new"]);

/** Banner copy keyed by the state.json classification that triggers it. */
const STATE_BANNER_MESSAGES = {
  corrupt:
    "Warning: state.json is corrupt. Freshness data is unavailable. Re-run `llmwiki compile` to restore.",
  "too-new":
    "Warning: this wiki's state was written by a newer version of llmwiki. Update llmwiki to view it safely.",
};

/** Prepend a state-status banner to `container` if one is not already in the document. */
function prependBannerIfNeeded(container, stateStatus) {
  if (!BANNER_STATE_STATUSES.has(stateStatus)) return;
  if (document.querySelector(".corrupt-state-banner")) return;
  container.prepend(buildStateStatusBanner(stateStatus));
}

/**
 * Build the state-status warning banner. Displayed when `/api/health` or
 * `/api/pages` reports `stateStatus === "corrupt"` (state.json could not be
 * parsed at viewer startup, so freshness data is unreliable) or `"too-new"`
 * (state.json was written by a newer llmwiki than this build understands).
 */
function buildStateStatusBanner(stateStatus) {
  const banner = document.createElement("div");
  banner.className = "corrupt-state-banner";
  banner.setAttribute("role", "alert");
  banner.textContent = STATE_BANNER_MESSAGES[stateStatus];
  return banner;
}

/** Render the home dashboard from the cached bootstrap payloads. */
async function loadAndRenderHome() {
  const data = bootstrapData.pages ? bootstrapData : await loadBootstrapData();
  if (!data.pages) {
    renderError("Could not load /api/pages");
    return;
  }
  applyHomeEnvelope(data.pages);
}

/** Apply a successfully fetched bootstrap payload to the chrome + main pane. */
function applyHomeEnvelope(envelope) {
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  // renderDashboard fills the shared support rail itself (compile receipt /
  // next actions / snapshot note, via renderDashboardRail) — no separate
  // rail call belongs here.
  renderDashboard(main, envelope, bootstrapData.health);
  injectGlobalCorruptBanner(envelope?.stateStatus);
}

/**
 * Inject the state-status banner into the app-layout container (above `main`)
 * so it persists across route changes. Runs once at app bootstrap from the
 * /api/pages envelope. No-ops when state is ok/missing or already injected.
 */
function injectGlobalCorruptBanner(stateStatus) {
  if (!BANNER_STATE_STATUSES.has(stateStatus)) return;
  if (document.querySelector(".corrupt-state-banner")) return;
  const layout = document.querySelector(".app-layout");
  if (!layout) return;
  layout.prepend(buildStateStatusBanner(stateStatus));
}

/** Fetch /api/index and render the rendered HTML coming back from the server. */
async function renderIndexPane(main) {
  clearSupportRail();
  try {
    const payload = await fetchJson("/api/index");
    main.innerHTML = "";
    main.appendChild(heading("h1", "Index"));
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
  main.appendChild(placeholder("wiki/index.md is not available. Run `llmwiki compile`."));
}

/** Fetch /api/page/:dir/:slug and render. */
async function renderPagePane(main, directory, slug) {
  try {
    const payload = await fetchJson(pageApiPath(directory, slug));
    renderPagePayload(main, payload, slug, await declaredFieldsFor(payload.entityType));
  } catch (err) {
    handlePageError(main, err, directory, slug);
  }
}

/** Build the `/api/page/:dir/:slug` URL with both segments percent-encoded. */
function pageApiPath(directory, slug) {
  return `/api/page/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`;
}

/** Render the body of a successful /api/page response into the main pane. */
function renderPagePayload(main, payload, slug, fieldDefs) {
  const title = payload.title || slug;
  main.innerHTML = "";
  main.appendChild(heading("h1", title));
  if (payload.pageDirectory === "queries") {
    main.appendChild(buildQueryQuestion(title));
  }
  appendWarnings(main, payload.warnings || []);
  const body = appendRenderedBody(main, payload.html);
  removeDuplicateLeadingHeading(body, title);
  renderSupportRail(payload, fieldDefs, titleFieldFor(payload.entityType));
}

/**
 * The fields the active profile declares for `entityType`, or undefined.
 *
 * AWAITS the envelope rather than reading whatever `bootstrapData` holds right
 * now. `main()` renders the route twice — once immediately, once after
 * `/api/pages` settles — and `unsettledOrPageRoute` deliberately lets a page
 * route resolve without the envelope. A synchronous read would therefore make
 * the two passes render DIFFERENT rails, and since each pass issues its own
 * `/api/page` fetch with no ordering guarantee between them, a cold deep link
 * whose first response landed second would be left permanently without its
 * declared fields. Awaiting makes both passes produce the same rail, so which
 * one wins stops mattering. Same idiom the index and dashboard routes use.
 *
 * Resolved here rather than in the rail because this module is already the one
 * place that reads `bootstrapData`; the rail stays a pure renderer of what it is
 * handed. A default page carries no `entityType`, so it never awaits and its
 * rail is byte-identical to before.
 */
async function declaredFieldsFor(entityType) {
  if (typeof entityType !== "string") return undefined;
  if (bootstrapData.pages === null) await loadBootstrapData();
  return declaredTypeRows().find((entry) => entry?.type === entityType)?.fields;
}

/**
 * The frontmatter key this entity type titles pages by, or undefined.
 *
 * Read synchronously from the cached envelope: it only ever SUPPRESSES a rail
 * row that duplicates the heading, so a miss before the envelope settles costs
 * one redundant row on the first of two paints rather than a wrong one.
 */
function titleFieldFor(entityType) {
  if (typeof entityType !== "string") return undefined;
  return declaredTypeRows().find((entry) => entry?.type === entityType)?.titleField;
}

/** Question banner shown above the body for saved-query pages. */
function buildQueryQuestion(title) {
  return el("p", "query-question", `Question: ${title}`);
}

/**
 * Render the not-found placeholder or a generic error for /api/page failures.
 *
 * 400 is treated as not-found alongside 404 because both mean "this hash does
 * not name a page": the server answers 400 when the directory is not one the
 * active profile declares, and 404 when the directory is valid but the page is
 * not there. To a reader those are the same fact, and since the hash router no
 * longer enumerates directories itself (see PAGE_HASH_PATTERN), 400 is the
 * ordinary response to a mistyped or stale link rather than a client defect.
 */
function handlePageError(main, err, directory, slug) {
  if (err.status !== 404 && err.status !== 400) {
    renderError(`Could not load page: ${err.message}`);
    return;
  }
  main.innerHTML = "";
  main.appendChild(placeholder(`Page not found: ${directory}/${slug}`));
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
  const note = placeholder("No rendered content.");
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
    main.appendChild(el("div", "warning-banner", w.message || w.code));
  }
}

/** Render a top-of-main error banner without crashing the rest of the UI. */
function renderError(message) {
  const main = document.querySelector(MAIN_SELECTOR);
  if (!main) return;
  main.innerHTML = "";
  main.appendChild(el("div", "warning-banner", message));
  clearSupportRail();
}

/** Fetch /api/graph and render the force-directed graph view. */
async function renderGraphPane(main) {
  clearSupportRail();
  main.innerHTML = "";
  main.className = "main-pane graph-pane";
  await loadGraph(main, { staleIds: staleIdsFromEnvelope(bootstrapData.pages) });
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

/** Bootstrap: first-paint nav, then parallel data fetch, then the router. */
function main() {
  wireThemeToggle();
  renderSidebar({});
  wireSearch({ fetchJson });
  void loadBootstrapData().then((data) => {
    renderSidebar(sidebarModel(data));
    renderHeader(data.pages, data.health);
    injectGlobalCorruptBanner(data.pages?.stateStatus);
    void renderRoute();
  });
  window.addEventListener("hashchange", () => {
    void renderRoute();
  });
  void renderRoute();
}

/** Project the bootstrap payloads into the sidebar's render model. */
// Optional chaining on three independent fields inflates cyclomatic count for
// what is a straight-line projection (cognitive complexity: 1).
// fallow-ignore-next-line complexity
function sidebarModel(data) {
  return {
    project: data.pages?.project,
    counts: navCounts(data.pages),
    lint: data.health?.lint ?? null,
    profileId: data.pages?.profileId,
    // BROWSE projects these into its type rows; absent on a default project,
    // which is what leaves that section exactly as it was.
    entityTypes: data.pages?.profilePipeline?.entityTypes,
  };
}

/**
 * The nav's count map: the envelope's own `counts`, plus `pipelineTypes` — how
 * many entity types the active profile declares.
 *
 * Derived here rather than carried inside `counts` because `counts` is a fixed
 * shape a DEFAULT project emits too, and a key that appears only for a profile
 * project would break the byte-identity that shape is pinned for. A default
 * envelope has no `profilePipeline`, so it gets its `counts` back untouched.
 */
function navCounts(envelope) {
  if (!envelope) return undefined;
  const entityTypes = envelope.profilePipeline?.entityTypes;
  if (!Array.isArray(entityTypes)) return envelope.counts;
  return { ...envelope.counts, pipelineTypes: entityTypes.length };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main, { once: true });
} else {
  main();
}
