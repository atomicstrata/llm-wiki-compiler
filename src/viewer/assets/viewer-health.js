/**
 * llmwiki viewer — the `#/health` route's view.
 *
 * Nebula's health screen answers one question in order: is anything wrong,
 * what is it, and where. So the page reads top to bottom as a head, a
 * CONTENTS strip of inert counts (deliberately one divided panel, not five
 * cards — five equal tiles gave a zero the same weight as a real figure),
 * then a two-column grid whose wide left side is the Lint panel and whose
 * right side stacks the profile problems panel, Freshness, Traceability, and
 * the cache note.
 *
 * The profile problems panel leads that column, and only exists when the
 * profile collector actually reported something. Its data was purpose-built to
 * stop a project with a bad entity directory or an invalid entity page reading
 * as healthy, so burying it under two panels that report on something else
 * would waste the one signal that says the project is broken.
 *
 * Both bootstrap payloads are needed: `/api/health` carries the counts and
 * the lint cache; `/api/pages` carries per-page freshness and the citation
 * totals. Either can be absent — every accessor here defaults rather than
 * assuming a field is present.
 *
 * The whole-wiki verdict is deliberately NOT stated here. It lives in the
 * persistent header (viewer-header.js), which speaks for every route; this
 * page briefly carried its own copy beside the title, and two derivations of
 * one verdict is exactly the drift that produced the contradiction it was
 * added to fix. The panels below report their own scoped facts instead.
 *
 * The Lint panel is in viewer-health-lint.js — see that module's header.
 */

import { el, displayLabel, technicalDetails } from "./viewer-dom.js";
import {
  formatUtcTimestamp,
  freshnessBadgeText,
  plural,
  relativeSince,
} from "./viewer-format.js";
import { buildLintPanel } from "./viewer-health-lint.js";

/** Rendered in place of a bold 0: an empty count is an absence, not news. */
const EMPTY_COUNT = "—";

/** Freshness statuses, in the order their bars are coloured by CSS modifier. */
const FRESHNESS_STATUSES = new Set(["fresh", "stale", "orphaned"]);

/**
 * The CONTENTS strip's five columns. `figure` returns the big number and
 * `suffix` the small mono phrase beside it, both reading a single `model`
 * assembled once by `buildContentsModel` so no accessor has to re-derive a
 * total or guard a null payload a second time.
 */
const CONTENTS_COLUMNS = [
  {
    key: "concepts",
    label: "Concepts",
    figure: (m) => m.concepts,
    suffix: () => "pages",
  },
  {
    key: "sources",
    label: "Sources",
    figure: (m) => m.sourceFiles,
    suffix: (m) => `${m.sources} compiled`,
  },
  {
    key: "citations",
    label: "Citations",
    figure: (m) => m.totalCitations,
    suffix: (m) => `${m.citedCitations} cited`,
  },
  {
    key: "queries",
    label: "Saved queries",
    figure: (m) => m.queries,
    suffix: (m) => (m.queries === 0 ? "none yet" : "answers"),
  },
  {
    key: "reviews",
    label: "Awaiting review",
    figure: (m) => m.pendingReviews,
    suffix: (m) => (m.pendingReviews === 0 ? "queue clear" : "candidates"),
  },
];

/**
 * Build the whole health view.
 *
 * @param {object|null} health - The `/api/health` payload.
 * @param {object|null} envelope - The `/api/pages` envelope.
 * @returns {HTMLElement}
 */
export function buildHealthView(health, envelope) {
  const model = buildContentsModel(health, envelope);
  const view = el("section", "health-view");
  view.appendChild(buildHead(health));
  view.appendChild(buildContentsStrip(model));
  const grid = el("div", "health-grid");
  grid.appendChild(buildLintPanel(health?.lint ?? null, routablePageIndex(envelope)));
  grid.appendChild(buildRightColumn(model));
  view.appendChild(grid);
  return view;
}

/**
 * Count fields `/api/health` carries, each defaulting to 0. The whole-wiki
 * `stale`/`orphaned` totals are deliberately absent: they belong to the
 * header's verdict, and the Freshness panel below reports the per-page counts
 * derived from the same rows it draws its bars from, so its badge, bars, and
 * sentence cannot contradict each other.
 */
const HEALTH_COUNT_KEYS = ["concepts", "queries", "sources", "sourceFiles", "pendingReviews"];

/**
 * Project both payloads into the one flat model every section below reads.
 * Citation totals are summed here rather than per-consumer so the CONTENTS
 * strip and the Traceability meter can never disagree about them.
 */
function buildContentsModel(health, envelope) {
  const pages = pagesOf(envelope);
  const conceptPages = pages.filter((page) => page.pageDirectory === "concepts");
  const citations = citationTotals(pages);
  return {
    ...healthCounts(health),
    profile: profileProblemsOf(envelope),
    totalCitations: citations.total,
    citedCitations: citations.total - citations.unresolved,
    unresolved: citations.unresolved,
    conceptPages,
    // Concept-page counts, derived from the same rows the bars are drawn
    // from, so the Freshness panel's bars, badge, and sentence cannot
    // contradict each other the way two independent sources would.
    stalePages: countStatus(conceptPages, "stale"),
    orphanedPages: countStatus(conceptPages, "orphaned"),
    // Pages whose freshness could not be computed at all (missing or corrupt
    // state.json). Counted separately because "not stale" and "we cannot
    // tell" are different facts, and the panel must not report the second as
    // the first.
    unverifiedPages: conceptPages.length - countVerified(conceptPages),
  };
}

/**
 * The profile collector's problems and their TRUE total.
 *
 * The list is CAPPED on the wire (`PROFILE_PROBLEM_CAP`, src/profile/block.ts)
 * while the total is the real figure, so the two are carried together: the
 * panel's badge and its "showing N of M" notice both speak from the total, and
 * a truncated list can never present itself as the whole set.
 *
 * A default-profile project carries neither field, which reads as an empty
 * list — the panel then renders nothing at all, exactly as before this input
 * reached the client.
 */
function profileProblemsOf(envelope) {
  const { profileProblems = [], profileProblemTotal } = envelope ?? {};
  return { problems: profileProblems, total: profileProblemTotal ?? profileProblems.length };
}

/** Count the pages whose freshness status is one the compiler actually resolved. */
function countVerified(pages) {
  return pages.filter((page) => FRESHNESS_STATUSES.has(page.freshness?.freshnessStatus)).length;
}

/** The envelope's page rows, or [] when `/api/pages` never arrived. */
function pagesOf(envelope) {
  return Array.isArray(envelope?.pages) ? envelope.pages : [];
}

/** Citation counts summed across every page, cited and uncited together. */
function citationTotals(pages) {
  return {
    total: sumBy(pages, (page) => page.citationCount ?? 0),
    unresolved: sumBy(pages, (page) => page.unresolvedCitationCount ?? 0),
  };
}

/** Read every HEALTH_COUNT_KEYS field off a possibly-absent payload. */
function healthCounts(health) {
  const counts = {};
  for (const key of HEALTH_COUNT_KEYS) counts[key] = health?.[key] ?? 0;
  return counts;
}

/** Count the pages carrying one freshness status. */
function countStatus(pages, status) {
  return pages.filter((page) => page.freshness?.freshnessStatus === status).length;
}

/** Sum a numeric projection over a list. */
function sumBy(items, project) {
  return items.reduce((total, item) => total + project(item), 0);
}

/** Index the envelope's pages by `"<directory>/<slug>"` for route lookups. */
function routablePageIndex(envelope) {
  return new Set(pagesOf(envelope).map((page) => `${page.pageDirectory}/${page.slug}`));
}

/** Build the page head: the title, then the lint-run caption. */
function buildHead(health) {
  const head = el("div", "health-head");
  head.appendChild(el("h1", "health-title", "Health"));
  head.appendChild(el("span", "health-lint-run", lintRunCaption(health?.lint ?? null)));
  return head;
}

/** Compose the "lint last run <ts> · <relative> ago" caption. */
function lintRunCaption(lint) {
  if (!lint) return "lint has never run";
  const stamp = `${formatUtcTimestamp(lint.at)}Z`;
  const since = relativeSince(lint.at);
  return since ? `lint last run ${stamp} · ${since} ago` : `lint last run ${stamp}`;
}

/** Build the CONTENTS strip: a head band above five rule-divided columns. */
function buildContentsStrip(model) {
  const strip = el("div", "contents-strip");
  const head = el("div", "contents-head");
  head.appendChild(el("span", "contents-eyebrow", "CONTENTS"));
  head.appendChild(el("span", "contents-caption", "counts only — nothing here is a problem"));
  strip.appendChild(head);
  const columns = el("div", "contents-columns");
  for (const column of CONTENTS_COLUMNS) columns.appendChild(buildContentsCell(column, model));
  strip.appendChild(columns);
  return strip;
}

/** Build one CONTENTS column: a label, then the figure and its mono suffix. */
function buildContentsCell(column, model) {
  const cell = el("div", "contents-cell");
  cell.dataset.contents = column.key;
  cell.appendChild(el("div", "contents-label", column.label));
  const figure = el("div", "contents-figure");
  const value = column.figure(model);
  const isZero = !(value > 0);
  figure.appendChild(
    el("span", `contents-value${isZero ? " is-zero" : ""}`, isZero ? EMPTY_COUNT : String(value)),
  );
  figure.appendChild(el("span", "contents-suffix", column.suffix(model)));
  cell.appendChild(figure);
  return cell;
}

/** Build the right-hand column: profile problems, Freshness, Traceability, cache note. */
function buildRightColumn(model) {
  const column = el("div", "health-column");
  const problems = buildProfileProblemsPanel(model.profile);
  if (problems) column.appendChild(problems);
  column.appendChild(buildFreshnessPanel(model));
  column.appendChild(buildTraceabilityPanel(model));
  column.appendChild(buildCacheNote());
  return column;
}

/**
 * Build the profile problems panel, or return null when the collector found
 * nothing to report.
 *
 * Nothing renders in the clean case on purpose. An empty panel headed "Profile
 * problems" would be a sixth count on a screen whose CONTENTS strip already
 * promises that counts are not problems, and a default-profile project has no
 * collector output to be empty about in the first place.
 *
 * @param {{problems: object[], total: number}} profile - Capped list and true total.
 * @returns {HTMLElement|null}
 */
function buildProfileProblemsPanel({ problems, total }) {
  if (problems.length === 0) return null;
  const panel = el("section", "panel profile-panel");
  panel.dataset.profilePanel = "";
  panel.appendChild(buildProfileHead(total));
  const body = el("div", "panel-body profile-body");
  for (const problem of problems) body.appendChild(buildProfileProblemRow(problem));
  panel.appendChild(body);
  const notice = buildCappedNotice(problems.length, total);
  if (notice) panel.appendChild(notice);
  return panel;
}

/**
 * Build the panel head: the title beside a warn-toned badge carrying the TRUE
 * count, reusing the same `.freshness-pill` badge the Freshness panel wears so
 * the two read as peers rather than as two unrelated inventions.
 */
function buildProfileHead(total) {
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-title", "Record problems"));
  head.appendChild(el("span", "freshness-pill is-warn", `${total} ${total === 1 ? "PROBLEM" : "PROBLEMS"}`));
  return head;
}

/**
 * Build one problem row: what is wrong (the collector's kind) beside where it
 * applies, with the collector's own message below.
 *
 * "Where" is the project-relative page path when the problem names a page and
 * the entity type when it does not — a directory-level problem (a missing or
 * malformed entity directory) carries no path at all, and a row naming no place
 * would leave the reader with nowhere to look.
 */
function buildProfileProblemRow(problem) {
  const row = el("div", "profile-problem");
  const head = el("div", "profile-problem-head");
  head.appendChild(el("span", "profile-problem-kind", problem.kind === "field-violation" ? "Missing or invalid information" : displayLabel(problem.kind)));
  const where = problem.path ?? problem.entityType;
  if (where) head.appendChild(el("span", "profile-problem-where", where));
  row.appendChild(head);
  row.appendChild(el("div", "profile-problem-message", problem.message));
  row.appendChild(technicalDetails(`Problem code: ${problem.kind}`));
  return row;
}

/**
 * Say how many of how many when the wire list was truncated, and nothing at
 * all when it is the whole set.
 *
 * The envelope caps the list (`PROFILE_PROBLEM_CAP`, src/profile/block.ts) but
 * always sends the true total, so silence here would let a capped list read as
 * the complete one — the same failure the Lint table's "other · N rules" row
 * and `/api/reviews`' "Showing 200 of 253" each already avoid.
 */
function buildCappedNotice(shown, total) {
  if (shown >= total) return null;
  return el("div", "profile-footer", `Showing ${shown} of ${plural(total, "problem")}.`);
}

/** Build the Freshness panel: a status badge, one bar per page, then a sentence. */
function buildFreshnessPanel(model) {
  const panel = el("section", "panel");
  panel.dataset.freshnessPanel = "";
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-title", "Freshness"));
  head.appendChild(buildFreshnessBadge(model));
  panel.appendChild(head);
  const body = el("div", "panel-body");
  body.appendChild(buildFreshnessBars(model.conceptPages));
  body.appendChild(el("div", "freshness-note", freshnessNote(model)));
  panel.appendChild(body);
  return panel;
}

/**
 * Badge the two actionable freshness counts. A wiki whose freshness could
 * not be computed at all gets neither the calm nor the warning treatment —
 * IN SYNC would assert something the state file cannot back up.
 */
function buildFreshnessBadge(model) {
  if (isWhollyUnverified(model)) return el("span", "freshness-pill is-unknown", "UNVERIFIED");
  const warn = model.stalePages > 0 || model.orphanedPages > 0;
  const text = freshnessBadgeText(model.stalePages, model.orphanedPages, "IN SYNC");
  return el("span", `freshness-pill ${warn ? "is-warn" : "is-ok"}`, text);
}

/** True when there are pages but not one of them has a resolved freshness status. */
function isWhollyUnverified(model) {
  const total = model.conceptPages.length;
  return total > 0 && model.unverifiedPages === total;
}

/**
 * Build one bar per concept page, coloured by that page's own status. Very
 * large wikis compress the bars — the row's fixed 4px gaps do not shrink —
 * which reads as "many pages" rather than breaking; the sentence below
 * always carries the exact counts regardless.
 */
function buildFreshnessBars(conceptPages) {
  const bars = el("div", "freshness-bars");
  for (const page of conceptPages) {
    const status = page.freshness?.freshnessStatus;
    const known = FRESHNESS_STATUSES.has(status) ? status : "unverified";
    bars.appendChild(el("div", `freshness-bar is-${known}`));
  }
  return bars;
}

/**
 * Compose the Freshness panel's sentence. Ordered by what the reader most
 * needs to know: real problems first, then the fact that freshness could not
 * be computed, and only then the all-clear — which is the one sentence that
 * would be a lie if either of the earlier cases applied.
 */
function freshnessNote(model) {
  const total = model.conceptPages.length;
  if (total === 0) return "No concept pages yet.";
  if (model.stalePages + model.orphanedPages > 0) {
    const stale = plural(model.stalePages, "page");
    const orphaned = plural(model.orphanedPages, "page");
    return `${stale} stale and ${orphaned} orphaned out of ${total}.`;
  }
  if (model.unverifiedPages > 0) return unverifiedNote(model, total);
  return "Every page is newer than its sources. Nothing stale, nothing orphaned.";
}

/** Say how much of the wiki's freshness could not be checked, and why. */
function unverifiedNote(model, total) {
  const scope =
    model.unverifiedPages === total
      ? "Freshness could not be checked for any page"
      : `Freshness could not be checked for ${plural(model.unverifiedPages, "page")}`;
  return `${scope} — state.json is missing or unreadable. Run \`llmwiki compile\` to restore it.`;
}

/**
 * Build the Traceability panel. The mockup measures "claims cited", but the
 * compiler maintains no claims inventory; citation resolution is the
 * equivalent fact that IS tracked (design spec §5.3), so the panel counts
 * citations that resolve to a real source span.
 */
function buildTraceabilityPanel(model) {
  const panel = el("section", "panel trace-meter");
  panel.dataset.traceabilityPanel = "";
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-title", "Traceability"));
  panel.appendChild(head);
  const body = el("div", "panel-body");
  body.appendChild(buildTraceHead(model));
  body.appendChild(buildTraceBar(model));
  body.appendChild(el("div", "trace-note", traceNote(model)));
  panel.appendChild(body);
  return panel;
}

/** Build the big percentage beside its "n / m citations" figure. */
function buildTraceHead(model) {
  const head = el("div", "trace-head");
  head.appendChild(el("span", "trace-value", `${citedPercent(model)}%`));
  head.appendChild(
    el("span", "trace-detail", `${model.citedCitations} / ${model.totalCitations} citations`),
  );
  return head;
}

/**
 * Share of citations that resolve, as a whole percent. A wiki with no
 * citations at all is fully traced by definition — reporting 0% would call
 * an empty wiki a failure.
 */
function citedPercent(model) {
  if (model.totalCitations === 0) return 100;
  return Math.round((model.citedCitations / model.totalCitations) * 100);
}

/**
 * Build the two-segment cited/uncited bar, reusing the design system's
 * meter track (viewer-dashboard.css). The width is a CSSOM property write,
 * not a markup `style=` attribute, so `style-src` needs no relaxation.
 */
function buildTraceBar(model) {
  const track = el("div", "bar-track");
  const fill = el("div", "bar-fill");
  fill.style.width = `${citedPercent(model)}%`;
  track.appendChild(fill);
  track.appendChild(el("div", "bar-remainder"));
  return track;
}

/** Compose the Traceability panel's sentence for each of its three states. */
function traceNote(model) {
  if (model.totalCitations === 0) return "No citations recorded yet.";
  if (model.unresolved === 0) return "Every citation resolves to a real source span.";
  const noun = model.unresolved === 1 ? "citation still points" : "citations still point";
  return `${model.unresolved} ${noun} at no source file — the rest resolve to a real span.`;
}

/**
 * Build the dim note explaining that lint figures come from a cache.
 *
 * A reload is enough, not a restart: `.llmwiki/last-lint.json` is the one
 * file the viewer re-reads per request (see `buildHealthResponse` in
 * health.ts), so the next render of this page already picks up a fresh lint
 * run. Page and graph data ARE frozen at startup, but saying so here would
 * attach a true caveat to the wrong fact and send the reader to restart a
 * server that did not need it.
 */
function buildCacheNote() {
  const note = el("div", "cache-note");
  note.appendChild(el("span", undefined, "Lint results are cached from the last run. Re-run "));
  note.appendChild(el("code", undefined, "llmwiki lint"));
  note.appendChild(el("span", undefined, " and reload this page to refresh."));
  return note;
}
