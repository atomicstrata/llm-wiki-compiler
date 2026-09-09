/**
 * llmwiki viewer — Overview dashboard.
 *
 * Four stat cards, a hero banner, the recently-compiled list, a compact
 * knowledge graph, a compile receipt, and a next-actions list.
 *
 * The graph panel is a real render, not a decorative picture: `mountGraphPanel`
 * calls the same `loadGraph()` the full `#/graph` route uses, with
 * `{ compact: true }` — one fetch path and one simulation builder for both,
 * so the panel can never show structure the full explorer disagrees with. It
 * mounts after the synchronous DOM build below returns, and fire-and-forgets
 * its own failures so a slow or broken `/api/graph` never blocks the rest of
 * the dashboard from painting.
 *
 * The cards keep the design's inventory/signal split: two report what the
 * wiki HAS, two report what needs a human. "Needs attention" is derived from
 * dangling links plus unresolved citations — both always present in the
 * snapshot — rather than from the lint cache, which is null until the first
 * `llmwiki lint` run and would leave the focal card blank on a new project.
 * Lint instead appears in the receipt and next actions, where "never run"
 * reads naturally.
 *
 * Next actions are informational. The viewer is read-only and cannot run any
 * of them, so each names the CLI command rather than offering a dead button.
 *
 * A panel (`buildPanel`, `buildGraphPanel`) is a bordered shell with NO
 * padding of its own — a head band, a body, and (where the mockup shows
 * one) a footer band, each supplying its own padding/border. `buildPanel`
 * handles the common single-title-plus-optional-link head shape shared by
 * the recently-compiled panel and the rail's receipt/next-actions panels;
 * the graph panel's head differs enough (title+caption grouped left,
 * Fit/expand chips right) that it builds its own via `buildGraphPanelHead`.
 *
 * The dashboard renders into TWO places, not one: `main` gets the stat
 * grid, hero, recently-compiled/graph split, and pattern strip directly
 * (no wrapping `.dashboard-primary` div — `.dashboard` on `main` itself
 * *is* the primary column, matching the mockup's flex layout); the compile
 * receipt, next actions, and snapshot note go into the shared
 * `[data-support-rail]` via `renderDashboardRail` instead of a private
 * `.dashboard-rail` column. That keeps the dashboard to the mockup's two
 * content columns — see the fidelity audit's A2 note — rather than a
 * third column only the home route ever showed.
 *
 * The pattern strip itself — the four-column explainer plus its dismiss
 * control — is built by `viewer-pattern.js`'s `buildPatternStrip()`, not
 * here (this file was already at CLAUDE.md's 400-line cap when the
 * dismiss/persistence logic was added). It returns `null` once dismissed;
 * `renderDashboard` below skips appending in that case.
 *
 * The stat card itself — label/badge/value/sub-line plus the warn/calm
 * state logic — is `viewer-stat-card.js`'s `buildStatCard()`, not defined
 * here. The health route (`viewer.js`) renders its own five-card grid
 * through the same function, so the card markup and its warn/calm rules
 * can never drift between the two surfaces.
 */

import { el, emptyState } from "./viewer-dom.js";
import { isWarnFreshness, lintTotal, plural, relativeAge } from "./viewer-format.js";
import { LEGEND_KINDS, loadGraph, staleIdsFromEnvelope } from "./viewer-graph.js";
import { buildPatternStrip } from "./viewer-pattern.js";
import { renderDashboardRail } from "./viewer-rail.js";
import { buildStatCard } from "./viewer-stat-card.js";
import {
  heroTotals,
  inventoryCard,
  inventoryLink,
  profileVocabulary,
} from "./viewer-dashboard-vocabulary.js";

/**
 * The three stat cards that mean the same thing whatever profile is active.
 * The FIRST card is the wiki's own inventory, whose label and number are the
 * active profile's to name — see `inventoryCard` (viewer-dashboard-vocabulary.js).
 *
 * `badge` is a fixed category noun (mockup tree lines 108/118/128) — true
 * regardless of the card's count, like "PAGES" or "INPUT" — except
 * `badgeWhenCalm` on "reviews": the mockup's "CLEAR" (tree line 139) only
 * reads correctly when the queue actually is empty, so it replaces the
 * fixed "QUEUE" label just for that state rather than being hardcoded
 * unconditionally (which would misread as "CLEAR" beside a non-zero
 * candidate count).
 */
const STAT_CARDS = [
  {
    key: "sources",
    label: "Sources",
    badge: "INPUT",
    value: (m) => m.counts.sourceFiles ?? 0,
    sub: (m) => `${m.counts.compiledSources ?? 0} compiled · ${m.counts.sourceFiles ?? 0} on disk`,
  },
  {
    key: "attention",
    label: "Needs attention",
    badge: "LINT",
    warnWhenNonZero: true,
    value: (m) => m.attention,
    // "dangling" alone is elliptical (short for "dangling [links]") and
    // never takes a plural suffix, so only the second half needs plural().
    sub: (m) => `${m.dangling} broken page links · ${plural(m.unresolved, "unresolved citation")}`,
  },
  {
    key: "reviews",
    label: "Awaiting review",
    badge: "QUEUE",
    badgeWhenCalm: "CLEAR",
    warnWhenNonZero: true,
    calmWhenZero: true,
    value: (m) => m.counts.pendingReviews ?? 0,
    sub: (m) =>
      (m.counts.pendingReviews ?? 0) === 0
        ? "queue is empty"
        : plural(m.counts.pendingReviews, "candidate"),
  },
];

/**
 * Render the Overview dashboard.
 *
 * @param {HTMLElement} main - The main pane.
 * @param {object} envelope - The /api/pages envelope.
 * @param {object|null} health - The /api/health payload, or null if it failed.
 */
export function renderDashboard(main, envelope, health) {
  const model = buildModel(envelope, health);
  main.innerHTML = "";
  main.className = "main-pane dashboard";
  main.appendChild(buildStatGrid(model));
  main.appendChild(buildHero(model));
  main.appendChild(buildSplit(model));
  // null once the user has dismissed it (viewer-pattern.js) — appending
  // nothing then, rather than an empty or hidden element.
  const patternStrip = buildPatternStrip();
  if (patternStrip) main.appendChild(patternStrip);
  renderDashboardRail([buildReceipt(model), buildNextActions(model), buildSnapshotNote()]);
  void mountGraphPanel(main, envelope);
}

/**
 * Render the compact graph into the reserved panel surface, then wire the
 * head's Fit button to the control handle `loadGraph` returns. Fire-and-forget:
 * a graph that fails to load leaves its own error banner inside the panel and
 * must not prevent the rest of the dashboard from rendering — the Fit button
 * simply stays disabled in that case (see `buildGraphPanelControls`).
 *
 * `fitButton` is captured synchronously here, alongside `surface`, rather
 * than re-queried after the `await` (see `wireFitButton`) — `viewer.js`'s
 * `main()` can call `renderRoute()` twice on first load (an immediate call
 * plus one after bootstrap data resolves), each replacing `main`'s children
 * wholesale. A live re-query at that point could resolve to a DIFFERENT
 * render's button than the one this call started with, wiring two click
 * listeners onto the surviving button instead of one.
 */
async function mountGraphPanel(main, envelope) {
  const surface = main.querySelector("[data-graph-panel]");
  if (!surface) return;
  const fitButton = main.querySelector("[data-graph-fit]");
  let handle = null;
  try {
    handle = await loadGraph(surface, { compact: true, staleIds: staleIdsFromEnvelope(envelope) });
  } catch {
    // loadGraph renders its own inline failure state; handle stays null.
  }
  wireFitButton(fitButton, handle);
}

/** Enable the Fit button and bind it to the handle's fit() action, once the graph has rendered. */
function wireFitButton(fitButton, handle) {
  if (!handle || !fitButton) return;
  fitButton.disabled = false;
  fitButton.addEventListener("click", () => handle.fit());
}

/** Derive every number the dashboard renders from the two payloads. */
// Optional chaining and nullish-coalescing defaults across the envelope and
// health payloads inflate cyclomatic count for what is a flat projection
// into one model object (cognitive complexity: 6).
// fallow-ignore-next-line complexity
function buildModel(envelope, health) {
  const pages = Array.isArray(envelope?.pages) ? envelope.pages : [];
  const dangling = envelope?.graph?.danglingCount ?? 0;
  const unresolved = sumBy(pages, (p) => p.unresolvedCitationCount ?? 0);
  const totalCitations = sumBy(pages, (p) => p.citationCount ?? 0);
  return {
    envelope,
    counts: envelope?.counts ?? {},
    graph: envelope?.graph ?? { nodeCount: 0, edgeCount: 0, danglingCount: 0 },
    recentPages: envelope?.recentPages ?? [],
    pageMetaById: pageMetaIndex(pages),
    pageCount: pages.length,
    totalCitations,
    // Concepts-only citation total for the "Concepts" stat card's sub-line —
    // totalCitations above is envelope-wide (concepts + queries) and would
    // mislabel a query's citations as belonging to the concepts card.
    conceptsCitations: citationsWhere(pages, (directory) => directory === "concepts"),
    // Null on a default project, which is what leaves every surface that reads
    // it exactly as it was.
    vocabulary: profileVocabulary(envelope, pages),
    unresolved,
    dangling,
    attention: dangling + unresolved,
    lint: health?.lint ?? null,
  };
}

/** Sum a numeric projection over a list. */
function sumBy(items, project) {
  return items.reduce((total, item) => total + project(item), 0);
}

/** Sum citationCount over the pages whose directory `matches`. */
function citationsWhere(pages, matches) {
  return sumBy(pages.filter((p) => matches(p.pageDirectory)), (p) => p.citationCount ?? 0);
}

/**
 * Index freshness and citation count by page id so recent rows can join
 * against both. `recentPages[]` (the envelope's own rows, see snapshot.ts
 * buildRecentPages) carries only id/title/slug/updatedAt — both figures
 * live on the matching `pages[]` row instead. One Map keyed by id, widened
 * to carry both fields, rather than two parallel indexes that could drift.
 */
function pageMetaIndex(pages) {
  const index = new Map();
  for (const page of pages) {
    index.set(page.id, { freshness: page.freshness, citationCount: page.citationCount });
  }
  return index;
}

/** Build the four-card stat grid: the profile's inventory card, then the fixed three. */
function buildStatGrid(model) {
  const grid = el("div", "stat-grid");
  for (const card of [inventoryCard(model.vocabulary), ...STAT_CARDS]) {
    grid.appendChild(buildStatCard(card, model));
  }
  return grid;
}

/** Build the hero banner with its two calls to action. */
function buildHero(model) {
  const hero = el("div", "hero");
  const copy = el("div", "hero-copy");
  copy.appendChild(el("div", "hero-title", "Your knowledge base is ready."));
  const totals = heroTotals(model);
  copy.appendChild(
    el("div", "hero-body",
      `${plural(totals.pages, "page")}, ` +
        `${plural(totals.citations, "citation")} traced to source spans.`),
  );
  hero.appendChild(copy);
  const actions = el("div", "hero-actions");
  if (model.envelope?.index?.available) {
    const index = el("a", "button button-primary", "Browse compiled index →");
    index.href = "#/index";
    actions.appendChild(index);
  }
  const graph = el("a", "button button-secondary", "Explore graph");
  graph.href = "#/graph";
  actions.appendChild(graph);
  hero.appendChild(actions);
  return hero;
}

/** Build the two-column split: recently compiled beside the graph panel. */
function buildSplit(model) {
  const split = el("div", "dashboard-split");
  split.appendChild(buildRecentPanel(model));
  split.appendChild(buildGraphPanel(model));
  return split;
}

/**
 * The panel's title, which cannot say "compiled" on a profile project.
 *
 * A default project's pages ARE compiled — the LLM pipeline writes them — so
 * the mockup's "Recently compiled" (tree line 160) is accurate there and stays
 * verbatim. A profile's typed entity pages are AUTHORED by hand under their
 * entity directory; `llmwiki compile` never produces one. "Updated" is the term
 * true of both, so the profile branch uses it rather than describing authored
 * pages as compiled. Same distinction `noTypedPagesState` already draws in
 * viewer-lists.js.
 */
function recentPanelTitle(model) {
  return model.vocabulary ? "Recently updated" : "Recently compiled";
}

/**
 * The panel's empty state. The default branch is the mockup's copy verbatim,
 * command included. The profile branch names no command at all: there is
 * nothing for the CLI to run, because the reader authors these pages
 * themselves — offering `llmwiki compile` would send them to a command that
 * cannot produce what the panel is waiting for.
 */
function recentEmptyState(model) {
  if (!model.vocabulary) {
    return emptyState(
      "Nothing compiled yet",
      "Compiled pages appear here newest first, each with its citation count and freshness.",
      "$ llmwiki compile",
    );
  }
  return emptyState(
    "Nothing authored yet",
    "Entity pages appear here newest first, each with its citation count. " +
      "Add Markdown records in this project’s category folders. This viewer is read-only.",
  );
}

/**
 * Build the recently-updated panel. The head's "View all" (mockup tree
 * line 161) and the footer's "All N concepts →" (tree line 223) point at the
 * same place — two affordances to one destination, matching the mockup's own
 * duplication rather than dropping one as redundant. WHICH place, and what the
 * footer one counts, is the active profile's vocabulary (see `inventoryLink`).
 */
function buildRecentPanel(model) {
  const inventory = inventoryLink(model);
  const panel = buildPanel(recentPanelTitle(model), buildTrailingLink("View all", inventory.href));
  const body = el("div", "panel-body");
  if (model.recentPages.length === 0) {
    body.appendChild(recentEmptyState(model));
  }
  for (const page of model.recentPages) {
    body.appendChild(buildRecentRow(page, model.pageMetaById.get(page.id)));
  }
  panel.appendChild(body);
  // The mockup's footer caption ("cited / total claims per page", tree line
  // 221) describes the per-row claims ratio this build omits (no claims
  // inventory to back it — see file header); this caption instead describes
  // what the row actually shows. The "All N …" count is real data, already
  // computed for the hero/stat cards above, not a mockup literal.
  panel.appendChild(
    buildPanelFooter(
      "cited pages, most recent first",
      buildTrailingLink(inventory.allText, inventory.href),
    ),
  );
  return panel;
}

/** Build one recently-compiled row. */
// Optional chaining, a predicate call, and a title fallback inflate
// cyclomatic count for what stays a single flat row builder
// (cognitive complexity: 3).
// fallow-ignore-next-line complexity
function buildRecentRow(page, meta) {
  const row = el("div", "recent-row");
  const status = meta?.freshness?.freshnessStatus ?? "unverified";
  // Same rule as the #/concepts and #/queries list rows (viewer-lists.js) —
  // only stale/orphaned warn. This dot and that one share the .list-dot
  // class and must never disagree about what a given status means.
  const warn = isWarnFreshness(status);
  const dot = el("span", `list-dot ${warn ? "is-warn" : "is-ok"}`);
  dot.title = status;
  dot.setAttribute("aria-label", status);
  row.appendChild(dot);
  const link = el("a", "recent-title", page.title || page.slug);
  link.href = `#/${encodeURIComponent(page.pageDirectory)}/${encodeURIComponent(page.slug)}`;
  row.appendChild(link);
  // The mockup's "8/8" is cited/total CLAIMS, which this build cannot
  // produce (no claims inventory — see file header); citationCount is the
  // approved substitution (design spec §5.3). Renders "0" rather than
  // nothing for an uncited page — the same fallback the #/concepts list
  // rows use (viewer-lists.js buildCitationCount) — so the age column
  // stays aligned and the two surfaces agree on what an uncited page shows.
  // Tinted by the SAME `warn` predicate as the dot above (mockup tree line
  // 183 — the Andrej Karpathy row's "9/10" is --warn beside a --warn dot),
  // so the figure and the dot can never disagree about one page's freshness.
  const citations = el("span", `recent-citations${warn ? " is-warn" : ""}`, String(meta?.citationCount ?? 0));
  row.appendChild(citations);
  row.appendChild(el("span", "recent-age", relativeAge(page.updatedAt)));
  return row;
}

/**
 * Build the graph panel shell: a head with the title/edge-count grouped on
 * the left and view-control chips on the right, the four-item legend, the
 * `[data-graph-panel]` surface `mountGraphPanel` renders the compact graph
 * into, and a footer. Unlike `buildRecentPanel`, this panel does not reuse
 * `buildPanel()`'s single-title head — the mockup's head shape here is
 * different (title + caption grouped left, two chips right; tree lines
 * 225-235), so it is built directly.
 */
function buildGraphPanel(model) {
  const panel = el("section", "panel graph-panel");
  panel.appendChild(buildGraphPanelHead(model));
  panel.appendChild(buildGraphLegend());
  const surface = el("div", "graph-panel-surface");
  surface.dataset.graphPanel = "";
  panel.appendChild(surface);
  panel.appendChild(buildPanelFooter("hover a node to inspect", buildDanglingNote(model.graph)));
  return panel;
}

/**
 * Build the graph panel's head: title + node/edge caption grouped left
 * (tree lines 226), Fit/expand chips right (tree lines 232-235). Fit is a
 * real button, disabled until `mountGraphPanel` wires it to the rendered
 * graph's control handle (see `wireFitButton`) — there is nothing to fit
 * before then. ⤢ is a real link to `#/graph`, live from the start since
 * navigation needs no graph handle.
 */
function buildGraphPanelHead(model) {
  const head = el("div", "panel-head");
  const left = el("div", "panel-head-group");
  left.appendChild(el("span", "panel-title", "Knowledge graph"));
  left.appendChild(
    el("span", "panel-caption", `${plural(model.graph.nodeCount, "node")} · ${plural(model.graph.edgeCount, "edge")}`),
  );
  head.appendChild(left);
  head.appendChild(buildGraphPanelControls());
  return head;
}

/**
 * Build the Fit / expand chip pair. Fit starts disabled (see
 * `buildGraphPanelHead`); the expand link needs no wiring at all — it is a
 * plain `<a href="#/graph">`, the same navigation the dashboard hero's own
 * "Explore graph" button uses, and the router already listens for
 * `hashchange` (viewer.js).
 */
function buildGraphPanelControls() {
  const controls = el("div", "panel-controls");
  const fit = el("button", "panel-chip", "Fit");
  fit.type = "button";
  fit.disabled = true;
  fit.dataset.graphFit = "";
  controls.appendChild(fit);
  const expand = el("a", "panel-chip", "⤢");
  expand.href = "#/graph";
  // The glyph alone is not an accessible name (WCAG 4.1.2) — title mirrors
  // it for a native hover tooltip too.
  expand.setAttribute("aria-label", "Open the full graph explorer");
  expand.title = "Open the full graph explorer";
  controls.appendChild(expand);
  return controls;
}

/**
 * Build the graph footer's trailing dangling-count note. Only tinted
 * --danger when non-zero (mockup tree line 258) — a zero count is good
 * news, not a warning, the same rule the stat cards' counter tiles use.
 * The mockup's left-hand "focus · Andrej Karpathy" (tree lines 254-257)
 * names whichever node is currently hovered; reproducing that would mean
 * wiring this footer to viewer-graph.js's hover state, so the footer's
 * caption instead names the real, always-available interaction (see
 * buildGraphPanel's "hover a node to inspect"). The count text runs through
 * the shared `plural()` (viewer-format.js, also used by the graph
 * explorer's node tooltip) rather than a hardcoded "targets" suffix, which
 * used to read "1 dangling targets" at exactly one dangling target.
 */
function buildDanglingNote(graph) {
  const className = graph.danglingCount > 0 ? "footer-danger" : undefined;
  return el("span", className, plural(graph.danglingCount, "dangling target"));
}

/**
 * Build the panel's own compact legend row (concept / entity / stale /
 * dangling — spec §5.3). `viewer-graph.js` suppresses its own overlay
 * legend in compact mode specifically because this panel renders one
 * instead (see its `loadGraph` JSDoc); without this row the panel would
 * show four colours of node with no key, making colour the only signal —
 * exactly what spec §6 requires the viewer to avoid.
 *
 * Reuses `LEGEND_KINDS` (the shared four-semantic list `nodeClass()` in
 * viewer-graph.js resolves against) and the `.graph-legend-dot--*` swatch
 * classes already styled in viewer-graph.css for the full explorer's own
 * legend, so this row can never drift into a second, disagreeing palette.
 * The trailing "size = degree" note (mockup tree line 249) is static —
 * always true, not derived from the model.
 */
function buildGraphLegend() {
  const row = el("div", "panel-legend");
  for (const { label, kind } of LEGEND_KINDS) {
    const item = el("div", "graph-legend-item");
    item.appendChild(el("div", `graph-legend-dot graph-legend-dot--${kind}`));
    item.appendChild(el("span", undefined, label));
    row.appendChild(item);
  }
  row.appendChild(el("span", "panel-legend-note", "size = degree"));
  return row;
}

/**
 * Build the rail's closing note: the viewer is a frozen, not live, snapshot.
 * The "llmwiki view" command is its own span (mockup tree line 368) so it can
 * carry the accent colour the surrounding sentence doesn't.
 */
function buildSnapshotNote() {
  const note = el("div", "snapshot-note");
  note.appendChild(
    document.createTextNode("The viewer serves a frozen snapshot. Changes on disk appear after "),
  );
  note.appendChild(el("span", "snapshot-command", "llmwiki view"));
  note.appendChild(document.createTextNode(" restarts."));
  return note;
}

/** Build the compile receipt panel. */
function buildReceipt(model) {
  const panel = buildPanel("Compile receipt");
  panel.dataset.compileReceipt = "";
  const body = el("div", "panel-body receipt-body");
  for (const [label, value] of receiptRows(model)) {
    body.appendChild(buildReceiptRow(label, value));
  }
  body.appendChild(buildMeter(model));
  panel.appendChild(body);
  return panel;
}

/**
 * Build one receipt label/value row. "Root" gets the wrapping, right-aligned
 * value variant (mockup tree line 296) — the only receipt value long enough
 * to need it; every other row's value fits on one line.
 */
function buildReceiptRow(label, value) {
  const row = el("div", "receipt-row");
  row.appendChild(el("span", "receipt-label", label));
  const isRootPath = label === "Root";
  row.appendChild(el("span", isRootPath ? "receipt-value receipt-value-path" : "receipt-value", value));
  return row;
}

/** Receipt label/value rows drawn from the envelope and lint cache. */
// Optional chaining and nullish-coalescing defaults across four independent
// envelope fields, plus the lint ternary, inflate cyclomatic count for what
// is a flat row-list projection (cognitive complexity: 5).
// fallow-ignore-next-line complexity
function receiptRows(model) {
  const rows = [
    ["Root", model.envelope?.project?.rootName ?? "—"],
    ["Profile", model.envelope?.profileId ?? "default"],
    ["State", model.envelope?.stateStatus ?? "unknown"],
    ["Index", model.envelope?.index?.available ? "available" : "not compiled"],
  ];
  rows.push(["Lint", model.lint ? plural(lintTotal(model.lint), "finding") : "never run"]);
  return rows;
}

/**
 * Build the citations-resolved meter. This replaces the mockup's
 * "Traceability" meter, which was backed by a claim inventory the compiler
 * does not maintain; citation resolution is the equivalent fact that IS
 * tracked.
 */
function buildMeter(model) {
  const total = model.totalCitations;
  const resolved = total - model.unresolved;
  const percent = total === 0 ? 100 : Math.round((resolved / total) * 100);
  const wrap = el("div", "meter");
  const head = el("div", "meter-head");
  head.appendChild(el("span", "meter-label", "Citations resolved"));
  head.appendChild(el("span", "meter-value", `${percent}%`));
  wrap.appendChild(head);
  // Two segments per the design system's meter: violet to the value, amber for
  // the shortfall. A neutral remainder would read as "no data" rather than
  // "this much is unresolved".
  const track = el("div", "bar-track");
  const fill = el("div", "bar-fill");
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  track.appendChild(el("div", "bar-remainder"));
  wrap.appendChild(track);
  wrap.appendChild(
    el("div", "meter-caption", `${resolved} of ${total} citations resolve to a source file`),
  );
  return wrap;
}

/** Build the informational next-actions panel. */
function buildNextActions(model) {
  const panel = buildPanel("Next actions");
  panel.dataset.nextActions = "";
  const body = el("div", "panel-body next-actions-body");
  for (const row of nextActionRows(model)) body.appendChild(buildActionRow(row));
  panel.appendChild(body);
  return panel;
}

/**
 * Build one next-action row: a coloured glyph (mockup tree lines 334/342/
 * 350/358) plus a title/hint pair stacked in a `flex:1` wrapper so the glyph
 * stays put while the text takes the remaining width.
 */
function buildActionRow({ glyph, title, hint }) {
  const row = el("div", "action-row");
  row.appendChild(el("span", "action-glyph", glyph));
  const text = el("span", "action-body");
  text.appendChild(el("span", "action-title", title));
  text.appendChild(el("span", "action-hint", hint));
  row.appendChild(text);
  return row;
}

/**
 * Only actions that currently apply; the export row always applies. Each
 * entry's glyph matches the mockup's fixed glyph-per-action-kind (dangling
 * ⌗, recompile ↻, lint ✓, export ⇩) — not per-position, so a future action
 * inserted between these would not need to guess a new symbol.
 */
// Three independent, non-nested guard conditions each appending one row
// inflate cyclomatic count for what stays a flat action list
// (cognitive complexity: 4).
// fallow-ignore-next-line complexity
function nextActionRows(model) {
  const rows = [];
  if (model.dangling > 0) {
    rows.push({
      glyph: "⌗",
      title: `Resolve ${plural(model.dangling, "dangling link")}`,
      hint: "create the pages or fix the targets",
    });
  }
  if ((model.counts.stale ?? 0) > 0) {
    rows.push({
      glyph: "↻",
      title: `Recompile ${plural(model.counts.stale, "stale page")}`,
      hint: "llmwiki compile",
    });
  }
  if (!model.lint) rows.push({ glyph: "✓", title: "Run lint", hint: "llmwiki lint" });
  rows.push({ glyph: "⇩", title: "Export for agents", hint: "llmwiki export" });
  return rows;
}

/**
 * Build a titled panel shell: a bordered container plus a head band
 * (title, and an optional trailing node such as a "View all" link).
 * Shared by the recently-compiled panel and the rail's compile-receipt /
 * next-actions panels — the graph panel's head shape differs too much to
 * reuse this (see buildGraphPanelHead).
 */
function buildPanel(title, trailing) {
  const panel = el("section", "panel");
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-title", title));
  if (trailing) head.appendChild(trailing);
  panel.appendChild(head);
  return panel;
}

/** Build a panel footer band: a caption on the left, a trailing node on the right. */
function buildPanelFooter(caption, trailing) {
  const footer = el("div", "panel-footer");
  footer.appendChild(el("span", undefined, caption));
  footer.appendChild(trailing);
  return footer;
}

/** Build a trailing `<a>` link, shared by a panel head's link and a panel footer's link. */
function buildTrailingLink(text, href) {
  const link = el("a", undefined, text);
  link.href = href;
  return link;
}
