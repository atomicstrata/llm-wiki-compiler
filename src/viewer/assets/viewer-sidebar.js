/**
 * llmwiki viewer — sidebar navigation.
 *
 * The Nebula sidebar is pure navigation: a project block, a BROWSE section,
 * a MAINTAIN section, and a docs card. The page tree and freshness filter
 * that used to live here now belong to the #/concepts list route, so the
 * sidebar stays a fixed height regardless of wiki size.
 *
 * BROWSE keeps a fixed spine — Overview, Sources, Graph explorer — and varies
 * only the type rows between them: they are whatever entity types the ACTIVE
 * PROFILE declares. A default project declares none through
 * `profilePipeline`, so its own Concepts and Queries rows stand and the sidebar
 * is exactly what it was. See viewer-nav-types.js for the ordering and
 * labelling rules the generated rows follow.
 *
 * Counts are advisory: every field of the render model is optional so first
 * paint can render the nav before /api/pages settles, and a failed
 * /api/health drops only the lint badge rather than blanking the nav.
 *
 * Entries whose surface does not exist in a read-only viewer (Settings,
 * Compile & export) are deliberately absent — see the design spec §2.3.
 */

import { el } from "./viewer-dom.js";
import { lintTotal } from "./viewer-format.js";
import { NAV_TYPE_SUMMARY_THRESHOLD, typeNavItems } from "./viewer-nav-types.js";
import { typeListHashType } from "./viewer-routes.js";

const SIDEBAR_SELECTOR = "[data-sidebar]";

/** Rendered when a count is present and zero. */
const EMPTY_COUNT = "—";

/** `profileId` the envelope reports when no profile is installed (server.ts). */
const DEFAULT_PROFILE_ID = "default";

/**
 * Nav entries per section. `count` names the `counts` key whose value is
 * shown; entries without one render no count. `route` doubles as the
 * `data-route` value `markActive` matches on.
 *
 * `zeroCountDisplay` sets what a zero count reads as, per section (mockup
 * tree lines 44/57): BROWSE has nothing to browse — an absence, shown as an
 * em dash; MAINTAIN's "zero pending reviews" is a meaningful, reassuring
 * fact rather than an absence, so it shows the literal digit instead.
 */
const NAV_SECTIONS = [
  {
    label: "BROWSE",
    zeroCountDisplay: "dash",
    // BROWSE is the section the active profile's vocabulary projects into: it
    // shows the profile name on its header and swaps its `profileTypeSlot`
    // rows for the profile's declared types. MAINTAIN does neither.
    showsProfileTypes: true,
    items: [
      // `profileTypeSlot`: Concepts and Queries are not fixed labels — they are
      // the two entity types the DEFAULT profile declares. On a project running
      // another profile they are replaced, in place, by that profile's own
      // types (see `sectionItems`). Project-wide navigation lives outside this
      // section: Dashboard above, source files and graph under Explore.
      { route: "concepts", href: "#/concepts", label: "Concepts", count: "concepts", profileTypeSlot: true },
      { route: "queries", href: "#/queries", label: "Queries", count: "queries", profileTypeSlot: true },
    ],
  },
  {
    label: "EXPLORE",
    zeroCountDisplay: "dash",
    items: [
      { route: "sources", href: "#/sources", label: "Sources", collisionLabel: "Source files", count: "sourceFiles" },
      { route: "graph", href: "#/graph", label: "Graph explorer" },
    ],
  },
  {
    label: "MAINTAIN",
    zeroCountDisplay: "digit",
    items: [
      { route: "health", href: "#/health", label: "Health & lint", badge: "lint" },
      { route: "reviews", href: "#/reviews", label: "Reviews", collisionLabel: "Review queue", count: "pendingReviews" },
      // No count: workflow runs are not in the bootstrap envelope (they live
      // outside the frozen snapshot and #/workflows fetches them per visit),
      // so the sidebar has no number to show without a second startup request.
      //
      // `profileOnly`: workflows are declared BY a profile, so a default-profile
      // project cannot have one — not "has none yet", but cannot. Showing the
      // entry there would advertise a capability the project is structurally
      // incapable of, and `llmwiki template init` refuses to add a profile to a
      // project that already has pages, so the empty state would be permanent.
      // The profile-vocabulary design gates it the same way: its default
      // sidebar has no Pipeline row, only the two profile ones do.
      { route: "workflows", href: "#/workflows", label: "Workflows", profileOnly: true },
      // `profileOnly` for the same structural reason as Workflows: only a
      // profile declares entity types and lifecycles, so a default project has
      // no pipeline to draw — which is exactly what the design's default
      // sidebar shows, and why its two profile sidebars are the only ones with
      // a Pipeline row. The count is the number of entity types the profile
      // declares (see `navCounts`, viewer.js) — the number of rows the panel
      // will have, not a workload.
      { route: "pipeline", href: "#/pipeline", label: "Lifecycle status", count: "pipelineTypes", profileOnly: true },
    ],
  },
];

/**
 * Leading segment of a PAGE hash, `#/<segment>/<slug>`.
 *
 * A page route's leading segment is its parent nav entry, so `#/concepts/alpha`
 * and `#/articles/alpha` both resolve to the entry that owns them without a
 * table to keep in step — including the per-project typed entries the sidebar
 * cannot enumerate here.
 *
 * The slug is REQUIRED. Every single-segment route the viewer has is in
 * {@link STATIC_ROUTE_FOR_HASH}, and a typed list route is namespaced
 * (`#/_type/articles`), so a bare `#/articles` routes nowhere — matching it here
 * would light a nav row while the pane shows the home fallback, which is the
 * highlight lying about where the reader is.
 */
const HASH_ROUTE_SEGMENT = /^#\/([^/]+)\/.+$/;

/** Hashes that resolve to the home route. */
const HOME_HASHES = new Set(["", "#", "#/"]);

/**
 * Exact-hash to nav route mapping for the static routes.
 *
 * The typed list routes are deliberately absent: they are per-project, and they
 * are namespaced (`#/_type/<entity-type>`) precisely so a profile's `sources`
 * type cannot claim the `#/sources` row above. {@link activeRouteName} resolves
 * the namespace before consulting this table.
 */
const STATIC_ROUTE_FOR_HASH = new Map([
  ["#/concepts", "concepts"],
  ["#/queries", "queries"],
  ["#/sources", "sources"],
  ["#/graph", "graph"],
  ["#/health", "health"],
  ["#/reviews", "reviews"],
  ["#/workflows", "workflows"],
  ["#/pipeline", "pipeline"],
  ["#/index", "home"],
]);

/**
 * Render the sidebar navigation.
 *
 * @param {{project?: {title?: string}, counts?: Record<string, number>,
 *          lint?: {warnings?: number, errors?: number} | null, profileId?: string,
 *          entityTypes?: {type: string, pageCount: number}[]}} model
 */
export function renderSidebar(model) {
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (!sidebar) return;
  sidebar.innerHTML = "";
  sidebar.appendChild(buildLockup());
  sidebar.appendChild(buildProjectBlock(model?.project));
  const dashboard = el("ul", "nav-list");
  dashboard.appendChild(buildNavItem({ route: "home", href: "#/", label: "Dashboard" }, "dash", model));
  sidebar.appendChild(dashboard);
  for (const section of NAV_SECTIONS) {
    sidebar.appendChild(buildNavSection(section, model));
  }
  sidebar.appendChild(buildFooterGroup());
  markActive();
}

/**
 * Build the product lockup: the 34px mark beside the product name and tagline.
 * The design system requires the mark never sit on a coloured plate, so this
 * renders directly on the sidebar surface with no background of its own.
 */
function buildLockup() {
  const wrap = el("div", "sidebar-lockup");
  const mark = document.createElement("img");
  mark.className = "sidebar-lockup-mark";
  mark.src = "/assets/llmwiki-logo-64.png";
  mark.width = 34;
  mark.height = 34;
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  wrap.appendChild(mark);
  const text = el("div", "sidebar-lockup-text");
  text.appendChild(el("div", "sidebar-lockup-name", "LLM Wiki Compiler"));
  text.appendChild(el("div", "sidebar-lockup-tagline", "compile once · reuse forever"));
  wrap.appendChild(text);
  return wrap;
}

/** Build the PROJECT block: name plus the local/read-only marker. */
function buildProjectBlock(project) {
  const wrap = el("div", "project-block");
  // PROJECT gets its own label class, not `.nav-section-label` — the
  // mockup gives it a different colour, margin, and no horizontal padding
  // compared to the BROWSE/MAINTAIN eyebrows (see viewer-chrome.css).
  wrap.appendChild(el("div", "project-label", "PROJECT"));
  const name = el("div", "project-name", project?.title || "llmwiki");
  name.dataset.projectName = "";
  wrap.appendChild(name);
  const status = el("div", "project-status");
  status.appendChild(el("span", "status-dot"));
  status.appendChild(el("span", undefined, "LOCAL · READ ONLY"));
  wrap.appendChild(status);
  return wrap;
}

/** Build one labelled nav section with the entries this project can actually use. */
function buildNavSection(section, model) {
  const typeItems = section.showsProfileTypes === true ? typeNavItems(model?.entityTypes) : [];
  const wrap = el("section", "nav-section");
  wrap.appendChild(buildSectionHead(section, model, typeItems));
  wrap.appendChild(buildNavList(section, model, typeItems));
  return wrap;
}

/**
 * The section's eyebrow row. BROWSE carries the active profile's name on it,
 * right-aligned — the vocabulary in play is a property of the whole section, so
 * it belongs on the header rather than costing a row of its own.
 */
function buildSectionHead(section, model, typeItems) {
  const head = el("div", "nav-section-head");
  const label = typeItems.length > 0 ? "CATEGORIES" : section.label;
  head.appendChild(el("div", "nav-section-label", label));
  const name = profileHeaderName(model?.profileId, typeItems);
  if (name !== null) head.appendChild(el("span", "nav-section-profile", name));
  return head;
}

/**
 * What the BROWSE header says about the active profile, or null when there is
 * nothing to say (a default project, or a section that shows no types).
 *
 * Long lists include a total for scanning; short lists need only the name.
 */
function profileHeaderName(profileId, typeItems) {
  if (typeItems.length === 0) return null;
  if (typeof profileId !== "string") return null;
  return typeItems.length > NAV_TYPE_SUMMARY_THRESHOLD ? `${profileId} · ${typeItems.length}` : profileId;
}

/** Build the section's `<ul>`, expanding the type-group marker where it appears. */
function buildNavList(section, model, typeItems) {
  const list = el("ul", "nav-list");
  const taken = typeLabelsInPlay(model);
  for (const item of sectionItems(section, typeItems)) {
    if (item === TYPE_GROUP) {
      appendTypeGroup(list, typeItems, section.zeroCountDisplay, model);
      continue;
    }
    if (!isNavItemApplicable(item, model)) continue;
    list.appendChild(buildNavItem(disambiguated(item, taken), section.zeroCountDisplay, model));
  }
  return list;
}

/**
 * Every label the active profile's type rows occupy, across the whole sidebar.
 *
 * Gathered once per render and passed to both sections, because a collision can
 * straddle them: a `reviews` entity type sits in BROWSE while the review queue
 * sits in MAINTAIN, and two rows reading "Reviews" are no less ambiguous for
 * being in different groups.
 */
function typeLabelsInPlay(model) {
  return new Set(typeNavItems(model?.entityTypes).map((item) => item.label));
}

/**
 * A fixed row, relabelled when a profile type has taken its name.
 *
 * The shipped `autosci` template declares entity types called `sources` and
 * `reviews`, so its sidebar rendered two rows reading "Sources" and two reading
 * "Reviews" — same accessible name, different destinations. Namespacing the
 * typed routes fixed where those rows GO; this fixes what they SAY.
 *
 * The fixed row yields, never the type row: an entity type's name is the
 * reader's own data and renaming it would misreport their profile, whereas
 * these labels are ours and the longer forms are the more precise ones anyway
 * — "Source files" is what that route lists, and "Review queue" is what that
 * one holds. A project whose profile takes neither name (every default project,
 * and `newsroom`) is untouched, which is what keeps the default sidebar
 * byte-identical.
 */
function disambiguated(item, takenLabels) {
  if (typeof item.collisionLabel !== "string") return item;
  if (!takenLabels.has(item.label)) return item;
  return { ...item, label: item.collisionLabel };
}

/** Marker standing in for the generated type rows inside a section's item list. */
const TYPE_GROUP = Object.freeze({ typeGroup: true });

/** True when an item is one of the default profile's own type rows. */
function isProfileTypeSlot(item) {
  return item.profileTypeSlot === true;
}

/**
 * The section's entries with the profile's types spliced into the slot the
 * default profile's first type row occupies — so a newsroom's Articles/Desks/
 * Bylines land exactly where Concepts sat, before Sources, and
 * the remaining default type row (Queries) drops out rather than duplicating
 * the same pages under a second vocabulary.
 *
 * With no declared types the items are returned untouched, which is the whole
 * default-project guarantee: one code path, and nothing to diff.
 */
function sectionItems(section, typeItems) {
  if (typeItems.length === 0) return section.items;
  const slot = section.items.findIndex(isProfileTypeSlot);
  // Nothing before the FIRST slot is itself a slot, so the head needs no filter.
  return [
    ...section.items.slice(0, slot),
    TYPE_GROUP,
    ...section.items.slice(slot + 1).filter((item) => !isProfileTypeSlot(item)),
  ];
}

/**
 * Show every type in normal flow. The sidebar owns scrolling, so taller
 * windows can expose the full vocabulary without a nested fixed-height list.
 */
function appendTypeGroup(list, typeItems, zeroCountDisplay, model) {
  list.appendChild(buildTypeGroup(typeItems, zeroCountDisplay, model));
}

/**
 * The type rows as one `<li>` holding a nested list, so BROWSE stays a single
 * `<ul>` and the fixed spine rows either side stay its direct siblings.
 */
function buildTypeGroup(typeItems, zeroCountDisplay, model) {
  const group = el("li", "nav-type-group");
  const inner = el("ul", "nav-type-list");
  for (const item of typeItems) inner.appendChild(buildNavItem(item, zeroCountDisplay, model));
  group.appendChild(inner);
  return group;
}

/**
 * Whether an entry's surface can exist in THIS project.
 *
 * Only `profileOnly` entries can be inapplicable, and the test is deliberately
 * "can this project ever have one", not "does it have one now" — an empty
 * Reviews queue still earns its row because a candidate can appear at any time,
 * whereas a default-profile project can never declare a workflow.
 *
 * Absent `profileId` (first paint, before /api/pages settles) hides the entry
 * rather than showing one that may vanish a moment later: appearing late is
 * quieter than flickering away, and the nav is re-rendered once the envelope
 * lands.
 */
function isNavItemApplicable(item, model) {
  if (item.profileOnly !== true) return true;
  const profileId = model?.profileId;
  return typeof profileId === "string" && profileId !== DEFAULT_PROFILE_ID;
}

/**
 * Build one nav `<li><a>` with its optional count or badge.
 *
 * A `title` marks the item as a generated type row: its label truncates with an
 * ellipsis (`.nav-link-type`, viewer-chrome.css) and keeps its full text on
 * hover, while the count never truncates because the count is what the eye
 * scans for. Fixed rows carry neither.
 */
function buildNavItem(item, zeroCountDisplay, model) {
  const li = el("li");
  const link = el("a", item.isType ? "nav-link nav-link-type" : "nav-link");
  link.href = item.href;
  link.dataset.route = item.route;
  if (item.isType) link.dataset.navType = "";
  const label = el("span", "nav-label", item.label);
  if (item.title) label.title = item.title;
  link.appendChild(label);
  appendNavMetric(link, item, zeroCountDisplay, model);
  li.appendChild(link);
  return li;
}

/**
 * Append the count or lint badge to a nav link, when one applies.
 *
 * `countValue` is the count a generated type row already carries; `count` names
 * a key in the shared `counts` map, which is how the fixed rows get theirs.
 */
// Optional chaining in the delegated lookups inflates cyclomatic count for what
// is a three-way dispatch (cognitive complexity: 3).
// fallow-ignore-next-line complexity
function appendNavMetric(link, item, zeroCountDisplay, model) {
  if (item.countValue !== undefined) {
    appendNavCount(link, item.countValue, zeroCountDisplay);
    return;
  }
  if (item.count) {
    appendNavCount(link, model?.counts?.[item.count], zeroCountDisplay);
    return;
  }
  if (item.badge === "lint") appendLintBadge(link, model?.lint);
}

/**
 * Append the count span, when the model actually carries a value for this
 * item. Zero-valued counts always get the `nav-count-zero` modifier, which
 * maps to `--fg-disabled` (viewer-chrome.css); the TEXT a zero renders as
 * depends on the section's `zeroCountDisplay` (see NAV_SECTIONS above) —
 * an em dash for BROWSE, the literal digit for MAINTAIN.
 */
function appendNavCount(link, value, zeroCountDisplay) {
  if (value === undefined) return;
  const isZero = !(value > 0);
  const className = isZero ? "nav-count nav-count-zero" : "nav-count";
  link.appendChild(el("span", className, navCountText(value, isZero, zeroCountDisplay)));
}

/** A zero's text is an em dash unless its section prefers the literal digit
 * (MAINTAIN); a non-zero count always renders as its number. */
function navCountText(value, isZero, zeroCountDisplay) {
  const zeroReadsAsDash = isZero && zeroCountDisplay !== "digit";
  return zeroReadsAsDash ? EMPTY_COUNT : String(value);
}

/** Append the lint badge, omitting it entirely when lint has never run (see lintTotal). */
function appendLintBadge(link, lint) {
  const total = lintTotal(lint);
  if (total === null) return;
  link.appendChild(el("span", "nav-badge", String(total)));
}

/**
 * Build the sidebar footer: a bottom-pinned column of standing cards
 * (mockup tree line 59). Only "Read the docs" ships — the mockup's
 * "Design system ↗" card links between design documents, not a product
 * surface, so it is deliberately absent (see the fidelity audit). The
 * group wrapper still exists on its own, matching the mockup's structure,
 * so a second card would space correctly if this ever grows one.
 */
function buildFooterGroup() {
  const group = el("div", "sidebar-footer");
  group.appendChild(buildDocsCard());
  return group;
}

/** The published documentation site. The repository README is a summary; this
 *  is the full reference the card's subtitle describes. */
const DOCS_URL = "https://llmwiki.atomicstrata.ai/introduction";

/** Build the standing "Read the docs" card pinned to the sidebar footer. */
function buildDocsCard() {
  const card = el("a", "docs-card");
  card.href = DOCS_URL;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  card.appendChild(el("div", "docs-card-title", "Read the docs"));
  card.appendChild(el("div", "docs-card-body", "Profiles, lint rules, export formats."));
  return card;
}

/**
 * Mark the nav entry matching the current hash as `aria-current="page"`.
 * Exported so viewer.js can call it after route changes without
 * duplicating the hash-parsing rules.
 */
export function markActive() {
  // Compared in JS rather than composed into a selector: a type route's name
  // comes from the hash, and a quoted attribute selector built from it would be
  // a syntax error (or worse) for a hand-edited URL.
  const links = Array.from(document.querySelectorAll(`${SIDEBAR_SELECTOR} a[data-route]`));
  for (const link of links) link.removeAttribute("aria-current");
  const active = activeRouteName(location.hash);
  if (!active) return;
  const match = markableLinks(links, location.hash).find((link) => link.dataset.route === active);
  match?.setAttribute("aria-current", "page");
}

/** True when a nav link is one of the generated entity-type rows. */
function isTypeLink(link) {
  return link.dataset.navType !== undefined;
}

/**
 * The links a hash is allowed to mark.
 *
 * Nothing stops a profile declaring an entity type named after a route the
 * viewer already owns — the built-in `autosci` template declares both `sources`
 * and `reviews` — and that type gets a BROWSE row carrying the same
 * `data-route` as the fixed entry. Which of the two lights up is decided by
 * WHICH HASH is being resolved, never by document order:
 *
 *   `#/_type/sources`  the type's own list route → only a type row may light
 *   `#/sources`        the viewer's own surface  → only a fixed row may light
 *   `#/sources/alpha`  a typed page, whose directory IS its entity type, so the
 *                      type row owns it; a default project has no type rows and
 *                      falls through to its fixed entry unchanged.
 */
function markableLinks(links, hash) {
  if (typeListHashType(hash) !== null) return links.filter(isTypeLink);
  if (STATIC_ROUTE_FOR_HASH.has(hash ?? "")) return links.filter((link) => !isTypeLink(link));
  return [...links.filter(isTypeLink), ...links.filter((link) => !isTypeLink(link))];
}

/**
 * Resolve a hash to the nav route that should be marked current.
 *
 * The namespace is consulted FIRST: a typed list hash names its type in its
 * SECOND segment (`#/_type/articles`), so the leading-segment rule below would
 * read it as the meaningless route `_type`.
 *
 * The static map comes next because one of its hashes does not name its own
 * segment either (`#/index` belongs to Overview). Everything else falls back to
 * the leading segment, which is the route name for the fixed list routes and the
 * parent entry for page routes alike — including the per-project typed pages the
 * sidebar cannot enumerate here.
 */
function activeRouteName(hash) {
  const key = hash ?? "";
  if (HOME_HASHES.has(key)) return "home";
  return typeListHashType(key) ?? fixedRouteName(key);
}

/** The nav route a hash outside the namespace names: the static table, then the
 *  page route's parent entry. */
function fixedRouteName(key) {
  return STATIC_ROUTE_FOR_HASH.get(key) ?? hashRouteSegment(key);
}

/** The leading segment of a hash route, or null when it has none. */
function hashRouteSegment(key) {
  const match = key.match(HASH_ROUTE_SEGMENT);
  return match ? match[1] : null;
}
