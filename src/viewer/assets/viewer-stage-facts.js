/**
 * @file viewer-stage-facts.js
 * @description CSP-safe DOM builders for verified stage facts. The module is
 * product-neutral: it renders bounded projection text, closed tone classes,
 * and provenance edges. Legacy product presentation lives in its own adapter.
 */

const FACT_TONES = new Set(["neutral", "success", "warning", "danger"]);
const STAGE_EDGE_FIELDS = [
  ["appliedTargets", "target", "target"],
  ["evidenceDigests", "evidence", "evidence"],
  ["groundedRefs", "grounding", "grounds on"],
];

/** Build all verified-only content for one stage. */
export function buildVerifiedStageFacts(stage) {
  const fragment = document.createDocumentFragment();
  if (stage?.verification !== "verified") return fragment;
  fragment.appendChild(buildProvenance(stage));
  const panel = buildFactPanel(stage.factPanel);
  if (panel) fragment.appendChild(panel);
  return fragment;
}

/** Build the product-neutral verified summary and evidence block. */
function buildProvenance(stage) {
  const wrap = document.createElement("div");
  wrap.className = "journey-provenance";
  wrap.appendChild(buildSpan("journey-provenance-caption", "What happened"));
  appendSummary(wrap, stage.summary);
  appendTargets(wrap, stage.appliedTargets);
  appendIfPresent(wrap, buildStageEdges(stage));
  appendIfPresent(wrap, buildDigestDetails(stage));
  return wrap;
}

/** Append the single verified summary sentence when present. */
function appendSummary(wrap, summary) {
  if (!isNonEmptyString(summary)) return;
  const paragraph = document.createElement("p");
  paragraph.className = "journey-summary";
  paragraph.textContent = summary;
  wrap.appendChild(paragraph);
}

/** Append applied targets as quiet chips. */
function appendTargets(wrap, targets) {
  const values = stringValues(targets);
  if (values.length === 0) return;
  const list = document.createElement("ul");
  list.className = "journey-chips";
  for (const value of values) list.appendChild(buildListItem("journey-chip", value));
  wrap.appendChild(list);
}

/** Build verified stage-to-target/evidence/grounding edges. */
function buildStageEdges(stage) {
  const edges = STAGE_EDGE_FIELDS.flatMap(([field, kind, label]) =>
    stringValues(stage[field]).map((value) => ({ kind, label, value })));
  if (edges.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "journey-edges-wrap";
  wrap.appendChild(buildHeading("h4", "Graph edges"));
  const list = document.createElement("ul");
  list.className = "journey-edges";
  for (const edge of edges) list.appendChild(buildStageEdge(stage.stageId, edge));
  wrap.appendChild(list);
  return wrap;
}

/** Build one literal-text edge row. */
function buildStageEdge(stageId, edge) {
  const row = buildListItem("journey-edge", `${stringOr(stageId, "stage")} → ${edge.label}: ${edge.value}`);
  row.dataset.edgeKind = edge.kind;
  return row;
}

/** Build expandable raw evidence values. */
function buildDigestDetails(stage) {
  const rows = [...stringValues(stage.evidenceDigests), ...stringValues(stage.groundedRefs)];
  if (rows.length === 0) return null;
  const details = document.createElement("details");
  details.className = "journey-digests";
  const summary = document.createElement("summary");
  summary.textContent = "Evidence digests";
  details.appendChild(summary);
  const list = document.createElement("ul");
  for (const value of rows) list.appendChild(buildListItem("journey-digest", value));
  details.appendChild(list);
  return details;
}

/** Build one generic fact panel from already verified values. */
function buildFactPanel(panel) {
  if (!hasFactPanelShape(panel)) return null;
  const rows = validFactRows(panel.rows);
  if (rows === null) return null;
  const section = document.createElement("section");
  section.className = "journey-fact-panel";
  section.appendChild(buildHeading("h4", panel.title, "journey-fact-panel-title"));
  const list = document.createElement("dl");
  list.className = "journey-fact-list";
  for (const row of rows) list.appendChild(row);
  section.appendChild(list);
  return section;
}

/** Convert a non-empty row array only when every row is displayable. */
function validFactRows(sourceRows) {
  const rows = sourceRows.map(buildFactRow);
  const valid = [rows.length > 0, rows.every((row) => row !== null)].every(Boolean);
  return valid ? rows : null;
}

/** True when a panel has the minimum text-and-array display shape. */
function hasFactPanelShape(panel) {
  if (!panel) return false;
  return isNonEmptyString(panel.title) && Array.isArray(panel.rows);
}

/** Build one fact label/value pair with a closed tone class. */
function buildFactRow(raw) {
  if (!hasFactRowShape(raw)) return null;
  const row = document.createElement("div");
  row.className = `journey-fact-row fact-tone-${raw.tone}`;
  row.appendChild(buildHeading("dt", raw.label));
  row.appendChild(buildHeading("dd", raw.value));
  return row;
}

/** True when a fact row uses non-empty text and one closed tone. */
function hasFactRowShape(raw) {
  if (!raw) return false;
  return [isNonEmptyString(raw.label), isNonEmptyString(raw.value), FACT_TONES.has(raw.tone)].every(Boolean);
}

/** Build a text-only element with optional class. */
function buildHeading(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/** Build a text-only span. */
function buildSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/** Build a text-only list item. */
function buildListItem(className, text) {
  const item = document.createElement("li");
  item.className = className;
  item.textContent = text;
  return item;
}

/** Append a node only when it exists. */
function appendIfPresent(parent, child) {
  if (child) parent.appendChild(child);
}

/** Keep only non-empty strings from an optional array. */
function stringValues(value) {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

/** True for a non-empty string. */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Return a non-empty string or its fallback. */
function stringOr(value, fallback) {
  return isNonEmptyString(value) ? value : fallback;
}
