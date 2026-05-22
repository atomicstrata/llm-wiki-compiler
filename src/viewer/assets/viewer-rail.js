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

/** Render project-level metadata for the dashboard route. */
export function renderProjectRail(envelope) {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (!support) return;
  support.innerHTML = "";
  const dl = document.createElement("dl");
  for (const { label, value } of buildProjectRailFields(envelope)) {
    appendPlainRailField(dl, label, value);
  }
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
  appendFrontmatterDl(support, extractFrontmatter(payload));
  const warnings = extractWarnings(payload);
  if (warnings.length > 0) support.appendChild(buildRailWarnings(warnings));
}

/** Clear the support rail entirely (used on non-page routes). */
export function clearSupportRail() {
  const support = document.querySelector(SUPPORT_SELECTOR);
  if (support) support.innerHTML = "";
}

/** Assemble the project-rail field list, appending the optional Index row. */
function buildProjectRailFields(envelope) {
  const fields = baseProjectFields(envelope);
  if (envelope.index && envelope.index.available) {
    fields.push({ label: "Index", value: "Available" });
  }
  return fields;
}

/** Always-present project-rail rows (project title, root, generated, pages). */
function baseProjectFields(envelope) {
  const project = projectInfo(envelope.project);
  const pages = envelope.pages || [];
  return [
    { label: "Project", value: project.title },
    { label: "Root", value: project.rootName },
    { label: "Generated", value: envelope.generatedAt || "" },
    { label: "Pages", value: String(pages.length) },
  ];
}

/** Normalize the envelope's `project` object with display-ready defaults. */
function projectInfo(project) {
  const safe = project || {};
  return {
    title: safe.title || "llmwiki",
    rootName: safe.rootName || "",
  };
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

/** Build and attach the frontmatter <dl> when at least one field rendered. */
function appendFrontmatterDl(support, fm) {
  const dl = document.createElement("dl");
  for (const field of RAIL_FIELDS) appendRailField(dl, field, fm[field.key]);
  if (dl.children.length > 0) support.appendChild(dl);
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
