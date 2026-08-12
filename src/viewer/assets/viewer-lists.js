/**
 * llmwiki viewer — list routes.
 *
 * Renders #/concepts, #/queries, #/sources, and the per-profile typed entity
 * lists (#/articles, #/papers, …) from the already-fetched /api/pages envelope.
 * No route here issues its own request.
 *
 * The freshness filter lives on #/concepts rather than the sidebar: it
 * narrows a page list, so it belongs beside the list it narrows. Filtering
 * is pure client-side work over rows already in memory — no endpoint and no
 * query parameters, matching the behaviour it replaces.
 */

import { el, emptyState, heading } from "./viewer-dom.js";
import { isWarnFreshness, relativeAge } from "./viewer-format.js";
import { navTypeLabel, typeDirectory } from "./viewer-nav-types.js";

/** Filter options offered on the concepts route. */
const FRESHNESS_FILTERS = [
  { value: "all", label: "All" },
  { value: "stale", label: "Stale" },
  { value: "orphaned", label: "Orphaned" },
  { value: "contradicted", label: "Contradicted" },
  { value: "archived", label: "Archived" },
];

/** Predicate per filter value; "all" is handled before this table is consulted. */
const FRESHNESS_PREDICATES = {
  stale: (f) => f.freshnessStatus === "stale",
  orphaned: (f) => f.freshnessStatus === "orphaned",
  contradicted: (f) => f.contradicted === true,
  archived: (f) => f.archived === true,
};

/** Render the concepts route with its freshness filter. */
export function renderConceptsList(main, envelope) {
  const pages = pagesIn(envelope, "concepts");
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Concepts"));
  const body = el("div", "list-body");
  const select = buildFreshnessFilter(() => {
    // A filtered-to-empty list is not the same as an empty project.
    const whenEmpty = select.value === "all" ? noConceptsState : noMatchesState;
    renderRows(body, applyFilter(pages, select.value), whenEmpty);
  });
  main.appendChild(select.parentElement ?? select);
  main.appendChild(body);
  renderRows(body, pages, noConceptsState);
}

/** Render the saved-queries route. */
export function renderQueriesList(main, envelope) {
  const pages = pagesIn(envelope, "queries");
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Saved queries"));
  const body = el("div", "list-body");
  main.appendChild(body);
  renderRows(body, pages, noQueriesState);
}

/**
 * Render one entity type's list — the destination a profile's BROWSE type row
 * lands on, and the peer of #/concepts and #/queries for a profile vocabulary.
 *
 * Reads the same envelope the other list routes read: typed entity pages arrive
 * with their entity type as their `pageDirectory`, so no extra request and no
 * second shape are involved. Rows link at `#/<type>/<slug>`, which the page
 * router and `/api/page/:directory/:slug` already resolve.
 *
 * @param {HTMLElement} main - The main pane.
 * @param {object} envelope - The `/api/pages` bootstrap envelope.
 * @param {string} type - The declared entity type id, already confirmed by the
 *   router against what the profile declares.
 */
export function renderEntityTypeList(main, envelope, type) {
  const pages = pagesIn(envelope, type);
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", navTypeLabel(type)));
  const body = el("div", "list-body");
  main.appendChild(body);
  const directory = typeDirectory(envelope?.profilePipeline?.entityTypes, type);
  renderRows(body, pages, () => noTypedPagesState(type, directory));
}

/**
 * Empty state for a type the profile declares but that has no valid page yet.
 *
 * No command: entity pages are AUTHORED, not compiled, so there is nothing for
 * the CLI to run — naming the directory is the actionable part, which is why it
 * comes from the profile's declaration rather than from the type id. Guessing
 * would send an author to a directory the collector never scans; they would
 * write pages, nothing would appear, and this same screen would still say the
 * type is empty. With no declaration on the envelope the sentence says where to
 * look instead of naming a path it cannot know.
 */
function noTypedPagesState(type, directory) {
  const where = directory ? `under wiki/${directory}/` : "in the directory your profile declares";
  return emptyState(
    `No ${type} yet`,
    `Your profile declares ${type} as an entity type. Author them as Markdown ${where} and they appear here with their citations.`,
  );
}

/**
 * Render the sources route: every filename under `sources/`, in the order
 * the snapshot lists them. Rows carry no per-file compiled/pending status —
 * the snapshot exposes a compiled COUNT (`counts.compiledSources`), not
 * per-file state, so there is no data to mark an individual row with. The
 * compiled-versus-on-disk fact is stated once, in the caption above the
 * list (see `buildSourcesCaption`).
 */
// Optional chaining on sourceFilenames/counts plus the empty-vs-populated
// branch inflates cyclomatic count for what is a linear render (cognitive
// complexity: 3).
// fallow-ignore-next-line complexity
export function renderSourcesList(main, envelope) {
  const names = Array.isArray(envelope?.sourceFilenames) ? envelope.sourceFilenames : [];
  main.innerHTML = "";
  main.className = "main-pane list-pane";
  main.appendChild(heading("h1", "Sources"));
  main.appendChild(buildSourcesCaption(envelope?.counts));
  const body = el("div", "list-body");
  main.appendChild(body);
  if (names.length === 0) {
    body.appendChild(
      emptyState(
        "No sources yet",
        "Sources are the raw files the compiler reads. Every claim on a page traces back to a span in one of them.",
        "$ llmwiki ingest <source>",
      ),
    );
    return;
  }
  for (const name of names) body.appendChild(buildSourceRow(name));
}

/** Caption stating how many of the files on disk have been compiled. */
// Optional chaining and nullish coalescing on the two count fields inflates
// cyclomatic count for what is a straight-line projection (cognitive
// complexity: 2).
// fallow-ignore-next-line complexity
function buildSourcesCaption(counts) {
  const compiled = counts?.compiledSources ?? 0;
  const onDisk = counts?.sourceFiles ?? 0;
  return el("p", "list-caption", `${compiled} compiled · ${onDisk} on disk`);
}

/**
 * Build one source row: just the filename. No status dot — see
 * `renderSourcesList` for why per-row status is not something this route
 * can show.
 */
function buildSourceRow(name) {
  const row = el("div", "list-row");
  row.appendChild(el("span", "list-title", name));
  return row;
}

/** Pages in a directory, newest first. */
function pagesIn(envelope, directory) {
  const pages = Array.isArray(envelope?.pages) ? envelope.pages : [];
  return pages
    .filter((page) => page.pageDirectory === directory)
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Replace a list body's rows. `whenEmpty` builds the empty state, which
 * differs by route and by whether a filter is narrowing the list — "nothing
 * matches this filter" and "nothing exists yet" are different facts and the
 * reader needs to know which one they are looking at.
 */
function renderRows(body, pages, whenEmpty) {
  body.innerHTML = "";
  if (pages.length === 0) {
    body.appendChild(whenEmpty());
    return;
  }
  for (const page of pages) body.appendChild(buildPageRow(page));
}

/** Empty state for a concepts list narrowed to nothing by the active filter. */
function noMatchesState() {
  return emptyState(
    "No pages match this filter",
    "Every page is outside the selected freshness state. Reset the filter to see the full list.",
  );
}

/** Empty state for a project with no compiled concept pages at all. */
function noConceptsState() {
  return emptyState(
    "No concepts yet",
    "Concepts are compiled pages — knowledge extracted once from your sources and kept with its citations.",
    "$ llmwiki compile",
  );
}

/** Empty state for a project with no saved queries. */
function noQueriesState() {
  return emptyState(
    "No saved queries yet",
    "Queries are compiled pages too — ask once and the answer is kept with its citations.",
    '$ llmwiki query "<question>"',
  );
}

/** Build one page row: freshness dot, linked title, citation count, age. */
function buildPageRow(page) {
  const row = el("div", "list-row");
  row.appendChild(buildFreshnessDot(page.freshness));
  const link = el("a", "list-title", page.title || page.slug);
  link.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
  row.appendChild(link);
  row.appendChild(buildCitationCount(page));
  row.appendChild(el("span", "list-age", relativeAge(page.updatedAt)));
  return row;
}

/**
 * Freshness dot. Colour alone never carries the meaning — the dot also
 * gets a title so assistive technology and hover both report the state.
 */
function buildFreshnessDot(freshness) {
  const status = freshness?.freshnessStatus ?? "unverified";
  const dot = el("span", `list-dot ${isWarnFreshness(status) ? "is-warn" : "is-ok"}`);
  dot.title = status;
  dot.setAttribute("aria-label", status);
  return dot;
}

/** Citation count chip, flagged when some citations do not resolve. */
// Nullish coalescing on the two count fields plus the two unresolved-citation
// ternaries inflates cyclomatic count for what is a two-field projection
// (cognitive complexity: 4).
// fallow-ignore-next-line complexity
function buildCitationCount(page) {
  const total = page.citationCount ?? 0;
  const unresolved = page.unresolvedCitationCount ?? 0;
  const chip = el("span", `list-citations${unresolved > 0 ? " is-warn" : ""}`, String(total));
  chip.title = unresolved > 0 ? `${unresolved} unresolved` : "citations";
  return chip;
}

/** Build the freshness filter control and return its `<select>`. */
function buildFreshnessFilter(onChange) {
  const wrap = el("div", "list-filter");
  const label = el("label", "list-filter-label", "Filter by freshness");
  label.setAttribute("for", "freshness-filter-select");
  const select = el("select", "list-filter-select");
  select.id = "freshness-filter-select";
  select.dataset.freshnessFilter = "";
  for (const { value, label: text } of FRESHNESS_FILTERS) {
    const option = el("option", undefined, text);
    option.value = value;
    select.appendChild(option);
  }
  select.addEventListener("change", onChange);
  wrap.appendChild(label);
  wrap.appendChild(select);
  return select;
}

/** Apply a filter value to a page list. */
function applyFilter(pages, filter) {
  if (filter === "all") return pages;
  const predicate = FRESHNESS_PREDICATES[filter];
  if (!predicate) return pages;
  return pages.filter((page) => page.freshness != null && predicate(page.freshness));
}
