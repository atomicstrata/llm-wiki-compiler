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
 */

const SIDEBAR_SELECTOR = "[data-sidebar]";
const DEFAULT_KIND = "concept";

/** Render the sidebar groups + standing Health entry, then mark active. */
export function renderSidebar(pages) {
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (!sidebar) return;
  sidebar.innerHTML = "";
  sidebar.appendChild(buildProjectSection());
  const concepts = pages.filter((p) => p.pageDirectory === "concepts");
  const queries = pages.filter((p) => p.pageDirectory === "queries");
  const conceptGroups = groupConceptsByKind(concepts);
  for (const [kind, groupPages] of conceptGroups) {
    sidebar.appendChild(buildCollapsibleGroup(formatKindLabel(kind), groupPages, "kind", kind));
  }
  if (queries.length > 0) {
    sidebar.appendChild(buildCollapsibleGroup("Saved Queries", queries, "kind", "query"));
  }
  if (concepts.length === 0 && queries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No pages yet — run `llmwiki compile`.";
    sidebar.appendChild(empty);
  }
  markActive();
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
  const expectedId = parseExpectedPageId(hash);
  const links = document.querySelectorAll(`${SIDEBAR_SELECTOR} a`);
  for (const link of links) link.removeAttribute("aria-current");
  if (hash === "#/graph") {
    document.querySelector('a[data-route="graph"]')?.setAttribute("aria-current", "page");
    return;
  }
  if (hash === "#/health") {
    document.querySelector('a[data-route="health"]')?.setAttribute("aria-current", "page");
    return;
  }
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
    const kind = (typeof page.kind === "string" && page.kind.length > 0) ? page.kind : DEFAULT_KIND;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(page);
  }
  const kinds = Array.from(byKind.keys()).sort((a, b) => {
    if (a === DEFAULT_KIND) return -1;
    if (b === DEFAULT_KIND) return 1;
    return a.localeCompare(b);
  });
  return kinds.map((kind) => /** @type {[string, Array]} */ ([kind, byKind.get(kind)]));
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
  wrap.className = "sidebar-health";
  const heading = document.createElement("h2");
  heading.textContent = "Project";
  wrap.appendChild(heading);
  const list = document.createElement("ul");
  const healthItem = document.createElement("li");
  const healthLink = document.createElement("a");
  healthLink.href = "#/health";
  healthLink.dataset.route = "health";
  healthLink.textContent = "Health";
  healthItem.appendChild(healthLink);
  list.appendChild(healthItem);
  const graphItem = document.createElement("li");
  const graphLink = document.createElement("a");
  graphLink.href = "#/graph";
  graphLink.dataset.route = "graph";
  graphLink.textContent = "Graph";
  graphItem.appendChild(graphLink);
  list.appendChild(graphItem);
  wrap.appendChild(list);
  return wrap;
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
