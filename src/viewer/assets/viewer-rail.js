/**
 * llmwiki viewer — right-hand support rail renderer.
 *
 * Populates `[data-support-rail]` with the page metadata fields the
 * spec's §Support Rail section requires: kind, sources, confidence,
 * provenanceState, contradictedBy, tags, aliases, created/updated
 * timestamps, plus a "Warnings" block fed by `payload.warnings`
 * (parser issues, unresolved citations, malformed citation entries).
 *
 * Freshness badges (STALE, ORPHANED, CONTRADICTED, ARCHIVED) are
 * rendered from `payload.freshness`. The design rule: badge ONLY the
 * two actionable source-freshness states (stale, orphaned) plus the
 * two provenance flags (contradicted, archived). `fresh` and
 * `unverified` get NO badge — badging neutral/default states would
 * stamp nearly the whole wiki. A "Freshness as of <generatedAt>"
 * caption is shown on every page (keyed on the always-present
 * `generatedAt`), anchoring the displayed freshness to snapshot/server-
 * start time because the viewer does not live-watch the filesystem.
 *
 * Fields render only when the frontmatter actually carries a value, so
 * a legacy page with no provenance metadata shows a compact rail
 * rather than a wall of `(none)` rows. Labels mirror `review show`
 * where practical.
 *
 * `[data-support-rail]` is a single shared element (one rail column in
 * the mockup, see viewer-chrome.css `.content-grid`) — every renderer
 * below targets the same `SUPPORT_SELECTOR` and replaces whatever was
 * there before, so only one of them "owns" the rail at a time. The
 * dashboard route calls `renderDashboardRail`; page routes call
 * `renderSupportRail`; every other route calls `clearSupportRail`.
 */

import { buildEntityFields, renderedFieldNames } from "./viewer-entity-fields.js";

const SUPPORT_SELECTOR = "[data-support-rail]";

const RAIL_FIELDS = [
  { key: "kind", label: "Kind", type: "string" },
  { key: "sources", label: "Sources", type: "stringArray" },
  { key: "confidence", label: "Confidence", type: "confidence" },
  { key: "provenanceState", label: "Provenance state", type: "string" },
  { key: "contradictedBy", label: "Contradicted by", type: "contradictedBy" },
  { key: "tags", label: "Tags", type: "stringArray" },
  { key: "aliases", label: "Aliases", type: "stringArray" },
  { key: "createdAt", label: "Created", type: "string" },
  { key: "updatedAt", label: "Updated", type: "string" },
];

/**
 * Dispatch table for field-value rendering. Function declarations below
 * are hoisted, so referencing them here at module-init time is safe.
 */
const RAIL_VALUE_RENDERERS = {
  string: renderStringValue,
  stringArray: renderStringArrayValue,
  confidence: renderConfidenceValue,
  contradictedBy: renderContradictionList,
};

/**
 * Render the dashboard's rail panels — compile receipt, next actions,
 * snapshot note — into the shared support rail. The dashboard is the only
 * caller that places more than one panel at once, so this takes a list of
 * built nodes rather than a single payload like `renderSupportRail` does.
 */
export function renderDashboardRail(panels) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  for (const panel of panels) support.appendChild(panel);
}

/**
 * Render the page metadata into the support rail. Replaces whatever
 * was there before — callers don't need to clear separately.
 *
 * On a TYPED entity page the page's own declared fields lead, because
 * {@link RAIL_FIELDS} below is the DEFAULT profile's vocabulary and describes a
 * contract a typed page was never under. The fixed list still runs after them,
 * minus any key the profile declares: an undeclared extra a page happens to
 * carry (a stray `tags`, a hand-written `updatedAt`) keeps rendering exactly as
 * before, and nothing is stated twice.
 *
 * The type's own title field is skipped: the page heading already shows that
 * value, so a row repeating it would state the same thing twice in the same
 * viewport — the very duplication this function avoids between the two lists.
 *
 * @param {object} payload - The `/api/page/:dir/:slug` response.
 * @param {{name: string, type: string}[]} [fieldDefs] - The declared fields of
 *   this page's entity type, from `profilePipeline`. Absent on a default page.
 * @param {string} [titleField] - The key this type titles pages by, if any.
 */
export function renderSupportRail(payload, fieldDefs, titleField) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  appendFreshnessBadges(support, payload);
  const frontmatter = extractFrontmatter(payload);
  const shown = withoutTitleField(fieldDefs, titleField);
  const declared = buildEntityFields(shown, frontmatter);
  if (declared) support.appendChild(declared);
  // Suppression is computed from the UNFILTERED declarations: a `titleField`
  // that happens to name a fixed-list key (`kind`, `tags`, …) is hidden from the
  // declared block because the heading shows it, and must stay hidden in the
  // fixed list too — otherwise removing it from one list would resurrect it in
  // the other, beside the heading it duplicates.
  appendFrontmatterDl(support, frontmatter, renderedFieldNames(fieldDefs, frontmatter));
  const warnings = extractWarnings(payload);
  if (warnings.length > 0) support.appendChild(buildRailWarnings(warnings));
  appendFreshnessCaption(support, payload);
}

/**
 * The declared fields minus the one the heading already shows. Returns the list
 * unchanged when the type declares no title field, so a type whose title is not
 * a declared field keeps every row it had.
 */
function withoutTitleField(fieldDefs, titleField) {
  if (!Array.isArray(fieldDefs) || typeof titleField !== "string") return fieldDefs;
  return fieldDefs.filter((def) => def?.name !== titleField);
}

/** Clear the support rail entirely (used on non-page routes). */
export function clearSupportRail() {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (support) support.innerHTML = "";
}

/** Pull the frontmatter object out of a page payload, defaulting to `{}`. */
function extractFrontmatter(payload) {
  if (!payload || !payload.frontmatter) return {};
  return payload.frontmatter;
}

/** Pull the warnings array out of a page payload, defaulting to `[]`. */
function extractWarnings(payload) {
  if (!payload || !Array.isArray(payload.warnings)) return [];
  return payload.warnings;
}

/**
 * Build and attach the fixed-list <dl> when at least one field rendered,
 * skipping any key the page's profile declares — those are already rendered
 * above, by their declared type rather than by this list's assumption about them.
 */
function appendFrontmatterDl(support, fm, declaredNames) {
  const dl = document.createElement("dl");
  for (const field of RAIL_FIELDS) {
    if (declaredNames.has(field.key)) continue;
    appendRailField(dl, field, fm[field.key]);
  }
  if (dl.children.length > 0) support.appendChild(dl);
}

/** Append one (dt, dd) pair to the rail's <dl> when the value renders. */
function appendRailField(dl, field, value) {
  const dd = renderRailValue(field.type, value);
  if (!dd) return;
  appendDtDd(dl, field.label, dd);
}

/** Append a complete rail definition row. */
function appendDtDd(dl, label, dd) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

/** Dispatch on field type and produce a <dd>, or null to skip the row. */
function renderRailValue(type, value) {
  const renderer = RAIL_VALUE_RENDERERS[type];
  return renderer ? renderer(value) : null;
}

/** String field — empty/non-string values omit the row. */
function renderStringValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return buildPlainDd(value);
}

/** Array-of-strings field — joined with commas, empty array omits the row. */
function renderStringArrayValue(value) {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v) => typeof v === "string" && v.length > 0);
  if (strings.length === 0) return null;
  return buildPlainDd(strings.join(", "));
}

/** Numeric confidence in 0..1 rendered as a percentage. */
function renderConfidenceValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  const clamped = Math.max(0, Math.min(1, value));
  return buildPlainDd(`${Math.round(clamped * 100)}%`);
}

/** `contradictedBy` is an array of `{ slug, reason? }` references. */
function renderContradictionList(value) {
  if (!Array.isArray(value)) return null;
  const items = value.map(buildContradictionItem).filter(Boolean);
  if (items.length === 0) return null;
  return buildContradictionDd(items);
}

/** Wrap a non-empty list of contradiction <li>s in their <dd><ul> container. */
function buildContradictionDd(items) {
  const dd = document.createElement("dd");
  const ul = document.createElement("ul");
  for (const li of items) ul.appendChild(li);
  dd.appendChild(ul);
  return dd;
}

/** One contradiction <li> — slug link plus optional reason. */
function buildContradictionItem(ref) {
  const slug = extractSlug(ref);
  if (!slug) return null;
  const li = document.createElement("li");
  li.dataset.contradictionSlug = slug;
  li.appendChild(buildContradictionLink(slug));
  appendContradictionReason(li, ref);
  return li;
}

/** Pull the slug string off a contradiction ref, or `""` when missing/malformed. */
function extractSlug(ref) {
  if (!ref || typeof ref.slug !== "string") return "";
  return ref.slug;
}

/** Build the `<a>` element that links a contradiction <li> to its concept page. */
function buildContradictionLink(slug) {
  const a = document.createElement("a");
  a.href = `#/concepts/${encodeURIComponent(slug)}`;
  a.textContent = slug;
  return a;
}

/** Append the optional `— reason` span when the ref carries a non-empty reason. */
function appendContradictionReason(li, ref) {
  if (!ref || typeof ref.reason !== "string" || ref.reason.length === 0) return;
  const reason = document.createElement("span");
  reason.className = "support-rail-reason";
  reason.textContent = ` — ${ref.reason}`;
  li.appendChild(reason);
}

/** Build a plain `<dd>` with a single text node — used by the simpler field types. */
function buildPlainDd(text) {
  const dd = document.createElement("dd");
  dd.textContent = text;
  return dd;
}

/**
 * Render the warnings block at the bottom of the rail. Each warning is
 * a `<li>` carrying `data-code` so styling/tests can target specific
 * warning kinds (`unresolved_citation`, `malformed_citation`,
 * `missing_title`, etc.).
 */
function buildRailWarnings(warnings) {
  const wrap = document.createElement("section");
  wrap.className = "support-rail-warnings";
  const h = document.createElement("h2");
  h.textContent = "Warnings";
  wrap.appendChild(h);
  const ul = document.createElement("ul");
  for (const w of warnings) ul.appendChild(buildWarningItem(w));
  wrap.appendChild(ul);
  return wrap;
}

/** Build one warning `<li>` with `data-code` set when the warning carries one. */
function buildWarningItem(warning) {
  const safe = warning || {};
  const li = document.createElement("li");
  if (typeof safe.code === "string") li.dataset.code = safe.code;
  li.textContent = warningText(safe);
  return li;
}

/** Pick the best human-readable label for a warning: message → code → "". */
function warningText(safe) {
  return safe.message || safe.code || "";
}

/**
 * Badge specs: each entry is [modifier, label, predicate(freshness)].
 * Only entries whose predicate is truthy produce a badge. Ordered by
 * axis: source-freshness first (stale, orphaned), then provenance
 * (contradicted, archived).
 */
const BADGE_SPECS = [
  ["stale",       "STALE",       (f) => f.freshnessStatus === "stale"],
  ["orphaned",    "ORPHANED",    (f) => f.freshnessStatus === "orphaned"],
  ["contradicted","CONTRADICTED",(f) => f.contradicted],
  ["archived",    "ARCHIVED",    (f) => f.archived],
];

/**
 * Append freshness badges to the rail. Badges render ONLY for actionable
 * states: STALE, ORPHANED (source-freshness axis) and CONTRADICTED,
 * ARCHIVED (provenance axis). `fresh` and `unverified` get no badge —
 * they are the neutral defaults and badging them would stamp nearly the
 * whole wiki with noise.
 */
function appendFreshnessBadges(support, payload) {
  const freshness = payload?.freshness;
  if (!freshness) return;
  const wrap = buildFreshnessBadgeWrap(freshness);
  if (wrap) support.appendChild(wrap);
}

/** Build the badges container from the freshness object, or null if no badges apply. */
function buildFreshnessBadgeWrap(freshness) {
  const activeBadges = BADGE_SPECS.filter(([, , pred]) => pred(freshness));
  if (activeBadges.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "freshness-badges";
  for (const [modifier, label] of activeBadges) wrap.appendChild(buildBadge(modifier, label));
  return wrap;
}

/** Build one badge `<span>` with a modifier class and text label. */
function buildBadge(modifier, label) {
  const span = document.createElement("span");
  span.className = `freshness-badge badge-${modifier}`;
  span.textContent = label;
  return span;
}

/**
 * Append the "Freshness as of <generatedAt>" caption when the payload
 * carries a generatedAt timestamp. Explicitly honest: the viewer
 * does not live-watch the filesystem, so this caption anchors the
 * freshness data to the server-start time rather than implying live state.
 */
function appendFreshnessCaption(support, payload) {
  if (!payload?.generatedAt) return;
  const caption = document.createElement("p");
  caption.className = "freshness-caption";
  caption.textContent = `Freshness as of ${payload.generatedAt}`;
  support.appendChild(caption);
}
