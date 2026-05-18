/**
 * llmwiki viewer — right-hand support rail renderer.
 *
 * Populates `[data-support-rail]` with the page metadata fields the
 * spec's §Support Rail section requires: kind, sources, confidence,
 * provenanceState, contradictedBy, tags, aliases, created/updated
 * timestamps, plus a "Warnings" block fed by `payload.warnings`
 * (parser issues, unresolved citations, malformed citation entries).
 *
 * Fields render only when the frontmatter actually carries a value, so
 * a legacy page with no provenance metadata shows a compact rail
 * rather than a wall of `(none)` rows. Labels mirror `review show`
 * where practical.
 */

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

/** Render project-level metadata for the dashboard route. */
export function renderProjectRail(envelope) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  const dl = document.createElement("dl");
  appendPlainRailField(dl, "Project", envelope.project?.title || "llmwiki");
  appendPlainRailField(dl, "Root", envelope.project?.rootName || "");
  appendPlainRailField(dl, "Generated", envelope.generatedAt || "");
  appendPlainRailField(dl, "Pages", String((envelope.pages || []).length));
  if (envelope.index?.available) appendPlainRailField(dl, "Index", "Available");
  support.appendChild(dl);
}

/**
 * Render the page metadata into the support rail. Replaces whatever
 * was there before — callers don't need to clear separately.
 */
export function renderSupportRail(payload) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  const fm = (payload && payload.frontmatter) || {};
  const dl = document.createElement("dl");
  for (const field of RAIL_FIELDS) appendRailField(dl, field, fm[field.key]);
  if (dl.children.length > 0) support.appendChild(dl);
  const warnings = (payload && Array.isArray(payload.warnings)) ? payload.warnings : [];
  if (warnings.length > 0) support.appendChild(buildRailWarnings(warnings));
}

/** Clear the support rail entirely (used on non-page routes). */
export function clearSupportRail() {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (support) support.innerHTML = "";
}

/** Append one (dt, dd) pair to the rail's <dl> when the value renders. */
function appendRailField(dl, field, value) {
  const dd = renderRailValue(field.type, value);
  if (!dd) return;
  appendDtDd(dl, field.label, dd);
}

/** Append a plain text rail field when `value` is non-empty. */
function appendPlainRailField(dl, label, value) {
  if (typeof value !== "string" || value.length === 0) return;
  appendDtDd(dl, label, buildPlainDd(value));
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
  if (type === "string") return renderStringValue(value);
  if (type === "stringArray") return renderStringArrayValue(value);
  if (type === "confidence") return renderConfidenceValue(value);
  if (type === "contradictedBy") return renderContradictionList(value);
  return null;
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
  if (!Array.isArray(value) || value.length === 0) return null;
  const dd = document.createElement("dd");
  const ul = document.createElement("ul");
  let any = false;
  for (const ref of value) {
    const li = buildContradictionItem(ref);
    if (!li) continue;
    any = true;
    ul.appendChild(li);
  }
  if (!any) return null;
  dd.appendChild(ul);
  return dd;
}

/** One contradiction <li> — slug link plus optional reason. */
function buildContradictionItem(ref) {
  const slug = ref && typeof ref.slug === "string" ? ref.slug : "";
  if (!slug) return null;
  const li = document.createElement("li");
  li.dataset.contradictionSlug = slug;
  const a = document.createElement("a");
  a.href = `#/concepts/${encodeURIComponent(slug)}`;
  a.textContent = slug;
  li.appendChild(a);
  if (ref && typeof ref.reason === "string" && ref.reason.length > 0) {
    const reason = document.createElement("span");
    reason.className = "support-rail-reason";
    reason.textContent = ` — ${ref.reason}`;
    li.appendChild(reason);
  }
  return li;
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
  for (const w of warnings) {
    const li = document.createElement("li");
    if (w && typeof w.code === "string") li.dataset.code = w.code;
    li.textContent = (w && w.message) || (w && w.code) || "";
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}
