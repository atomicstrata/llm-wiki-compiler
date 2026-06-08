/**
 * llmwiki viewer — sidebar renderer.
 *
 * Renders the standing project links first, then concept pages grouped
 * by frontmatter `kind` (defaulting to "concept" when absent — spec
 * line 347), then a "Saved Queries" group. Groups use native
 * `<details><summary>` so keyboard users get Enter/Space collapse for
 * free without bespoke ARIA wiring.
 *
 * First paint runs against the embedded page-index blob (which now
 * includes `kind` so the grouping is correct from the first byte);
 * the full `/api/pages` envelope replaces the contents once it
 * arrives.
 *
 * A per-axis freshness filter (all / stale / orphaned / contradicted /
 * archived) narrows the page list client-side over the already-loaded
 * `/api/pages` rows. No new endpoint is needed — the filter is pure
 * DOM manipulation over the in-memory page list.
 */

const SIDEBAR_SELECTOR = "[data-sidebar]";
const DEFAULT_KIND = "concept";
const EMPTY_PLACEHOLDER_TEXT = "No pages yet — run `llmwiki compile`.";

/**
 * CSS class on the standing "Project" section. Shared between
 * `buildProjectSection` (which sets it) and `reRenderSidebarGroups`
 * (whose keep-selector preserves it across filter re-renders) so a
 * rename can't silently break the re-render keep-list.
 */
const PROJECT_SECTION_CLASS = "sidebar-health";

/** The active freshness filter. "all" means no narrowing. */
let activeFreshnessFilter = "all";

/** Available filter values and their human labels. */
const FRESHNESS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "stale", label: "Stale" },
  { value: "orphaned", label: "Orphaned" },
  { value: "contradicted", label: "Contradicted" },
  { value: "archived", label: "Archived" },
];

/**
 * Static (non-page) hash routes that have a dedicated sidebar link.
 * `markActive` highlights the entry via `a[data-route="<route>"]`
 * without needing to parse the route descriptor.
 */
const STATIC_ROUTE_LINK_SELECTORS = new Map([
  ["#/graph", 'a[data-route="graph"]'],
  ["#/health", 'a[data-route="health"]'],
]);

/** Full page list captured at the last renderSidebar call for filter re-renders. */
let lastPages = [];

/** Render the sidebar groups + standing Health entry, then mark active. */
export function renderSidebar(pages) {
  lastPages = pages;
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (!sidebar) return;
  sidebar.innerHTML = "";
  sidebar.appendChild(buildProjectSection());
  sidebar.appendChild(buildFreshnessFilter());
  renderFilteredGroups(sidebar, pages);
  markActive();
}

/** Re-render only the page groups using the stored lastPages + active filter. */
function reRenderSidebarGroups() {
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (!sidebar) return;
  // Remove everything after the project section and filter control.
  const keep = sidebar.querySelectorAll(`section.${PROJECT_SECTION_CLASS}, .freshness-filter`);
  const keepSet = new Set(Array.from(keep));
  Array.from(sidebar.children).forEach((child) => {
    if (!keepSet.has(child)) child.remove();
  });
  renderFilteredGroups(sidebar, lastPages);
  markActive();
}

/** Append the filtered concept/query groups and the empty placeholder if needed. */
function renderFilteredGroups(sidebar, pages) {
  const filtered = applyFreshnessFilter(pages, activeFreshnessFilter);
  const concepts = filterByDirectory(filtered, "concepts");
  const queries = filterByDirectory(filtered, "queries");
  appendConceptGroups(sidebar, concepts);
  appendQueryGroup(sidebar, queries);
  appendEmptyPlaceholderIfNeeded(sidebar, concepts, queries);
}

/** Filter pages to those whose `pageDirectory` matches the given bucket. */
function filterByDirectory(pages, directory) {
  return pages.filter((p) => p.pageDirectory === directory);
}

/** Append one collapsible `<details>` group per concept kind. */
function appendConceptGroups(sidebar, concepts) {
  for (const [kind, groupPages] of groupConceptsByKind(concepts)) {
    sidebar.appendChild(buildCollapsibleGroup(formatKindLabel(kind), groupPages, "kind", kind));
  }
}

/** Append the Saved Queries group when at least one query page exists. */
function appendQueryGroup(sidebar, queries) {
  if (queries.length === 0) return;
  sidebar.appendChild(buildCollapsibleGroup("Saved Queries", queries, "kind", "query"));
}

/** Render the "No pages yet" placeholder when both buckets are empty. */
function appendEmptyPlaceholderIfNeeded(sidebar, concepts, queries) {
  if (concepts.length > 0 || queries.length > 0) return;
  const empty = document.createElement("p");
  empty.className = "placeholder";
  empty.textContent = EMPTY_PLACEHOLDER_TEXT;
  sidebar.appendChild(empty);
}

/**
 * Mark the sidebar entry matching the current hash route as
 * `aria-current="page"` and clear it from every other entry. Exported
 * so `viewer.js` can call it after route changes without duplicating
 * the parsing logic. Reads `location.hash` directly so the call site
 * doesn't need to thread the route descriptor through.
 */
export function markActive() {
  const hash = location.hash;
  const links = document.querySelectorAll(`${SIDEBAR_SELECTOR} a`);
  clearCurrentAttribute(links);
  if (markStaticRoute(hash)) return;
  markPageRoute(links, parseExpectedPageId(hash));
}

/** Remove `aria-current` from every sidebar link in `links`. */
function clearCurrentAttribute(links) {
  for (const link of links) link.removeAttribute("aria-current");
}

/**
 * Apply `aria-current="page"` to the static-route link for `hash`,
 * if the hash names a known static route. Returns true when handled
 * so the page-route fallback can be skipped.
 */
function markStaticRoute(hash) {
  const selector = STATIC_ROUTE_LINK_SELECTORS.get(hash);
  if (!selector) return false;
  document.querySelector(selector)?.setAttribute("aria-current", "page");
  return true;
}

/** Apply `aria-current="page"` to the link whose pageId matches `expectedId`. */
function markPageRoute(links, expectedId) {
  if (!expectedId) return;
  for (const link of links) {
    if (link.dataset.pageId === expectedId) {
      link.setAttribute("aria-current", "page");
      return;
    }
  }
}

/**
 * Group concept pages by their `kind` field. Missing/non-string kinds
 * fall back to `"concept"` per spec §Sidebar. Group order is stable
 * by kind name (locale-aware), with the default `concept` bucket
 * floated to the top so a typical wiki shows "Concept" first.
 */
function groupConceptsByKind(concepts) {
  const byKind = new Map();
  for (const page of concepts) {
    addPageToKindBucket(byKind, page);
  }
  const kinds = Array.from(byKind.keys()).sort(compareKinds);
  return kinds.map((kind) => /** @type {[string, Array]} */ ([kind, byKind.get(kind)]));
}

/** Push `page` onto the bucket for its resolved kind, creating it if needed. */
function addPageToKindBucket(byKind, page) {
  const kind = resolveKind(page);
  if (!byKind.has(kind)) byKind.set(kind, []);
  byKind.get(kind).push(page);
}

/** Read `page.kind` defensively, falling back to DEFAULT_KIND when absent. */
function resolveKind(page) {
  if (typeof page.kind === "string" && page.kind.length > 0) return page.kind;
  return DEFAULT_KIND;
}

/** Sort comparator that floats DEFAULT_KIND first, then locale-orders the rest. */
function compareKinds(a, b) {
  if (a === DEFAULT_KIND) return -1;
  if (b === DEFAULT_KIND) return 1;
  return a.localeCompare(b);
}

/** Title-case a kind for the group heading. */
function formatKindLabel(kind) {
  if (kind === DEFAULT_KIND) return "Concepts";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Build a collapsible `<details>` group with a flat link list of pages. */
function buildCollapsibleGroup(label, pages, datasetKey, datasetValue) {
  const wrap = document.createElement("details");
  wrap.open = true;
  if (datasetKey) wrap.dataset[datasetKey] = datasetValue;
  const summary = document.createElement("summary");
  summary.textContent = label;
  wrap.appendChild(summary);
  const list = document.createElement("ul");
  for (const page of pages) list.appendChild(buildPageListItem(page));
  wrap.appendChild(list);
  return wrap;
}

/** Build one `<li><a>` entry for a sidebar page list. */
function buildPageListItem(page) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
  a.dataset.pageId = page.id;
  a.textContent = page.title || page.slug;
  li.appendChild(a);
  return li;
}

/** Build the standing "Project" sidebar section with Health and Graph links. */
function buildProjectSection() {
  const wrap = document.createElement("section");
  wrap.className = PROJECT_SECTION_CLASS;
  const heading = document.createElement("h2");
  heading.textContent = "Project";
  wrap.appendChild(heading);
  const list = document.createElement("ul");
  list.appendChild(buildProjectRouteItem("#/health", "health", "Health"));
  list.appendChild(buildProjectRouteItem("#/graph", "graph", "Graph"));
  wrap.appendChild(list);
  return wrap;
}

/** Build one `<li><a>` entry for the standing Project section. */
function buildProjectRouteItem(href, route, label) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = href;
  link.dataset.route = route;
  link.textContent = label;
  item.appendChild(link);
  return item;
}

/**
 * Read `location.hash` and return the namespaced `<dir>/<slug>` that
 * should carry `aria-current` — or null if the route is not a page
 * route. Malformed percent-encoding falls through to null rather than
 * throwing.
 */
function parseExpectedPageId(hash) {
  const match = hash.match(/^#\/(concepts|queries)\/(.+)$/);
  if (!match) return null;
  let slug;
  try {
    slug = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return `${match[1]}/${slug}`;
}

/**
 * Build the freshness-filter `<div>` with a `<select>` control. The
 * filter is client-side over the already-loaded page rows — no new
 * endpoint, no query params.
 */
function buildFreshnessFilter() {
  const wrap = document.createElement("div");
  wrap.className = "freshness-filter";
  const label = document.createElement("label");
  label.className = "freshness-filter-label";
  label.setAttribute("for", "freshness-filter-select");
  label.textContent = "Filter by freshness";
  const select = document.createElement("select");
  select.id = "freshness-filter-select";
  select.className = "freshness-filter-select";
  for (const { value, label: optLabel } of FRESHNESS_FILTER_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = optLabel;
    if (value === activeFreshnessFilter) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", onFreshnessFilterChange);
  wrap.appendChild(label);
  wrap.appendChild(select);
  return wrap;
}

/** Handle freshness filter selection change — update state and re-render. */
function onFreshnessFilterChange(event) {
  activeFreshnessFilter = event.target.value;
  reRenderSidebarGroups();
}

/**
 * Lookup table: filter value → predicate over a freshness object.
 * Keeps `matchesFreshnessFilter` branch-free.
 */
const FRESHNESS_PREDICATES = {
  stale:       (f) => f.freshnessStatus === "stale",
  orphaned:    (f) => f.freshnessStatus === "orphaned",
  contradicted:(f) => f.contradicted === true,
  archived:    (f) => f.archived === true,
};

/**
 * Apply the active freshness filter to the page list. "all" returns all
 * pages; other values match the corresponding freshness flag on each page.
 */
function applyFreshnessFilter(pages, filter) {
  if (filter === "all") return pages;
  return pages.filter((page) => matchesFreshnessFilter(page, filter));
}

/** True when the page's freshness satisfies the active filter. */
function matchesFreshnessFilter(page, filter) {
  const f = page.freshness;
  const predicate = FRESHNESS_PREDICATES[filter];
  return f != null && predicate != null && predicate(f);
}
