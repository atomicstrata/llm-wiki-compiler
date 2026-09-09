/**
 * Read-only entity relations and evidence from the frozen page projection.
 * Labels always use textContent. Navigation is constructed from identifiers;
 * connector URLs are checked independently at this browser boundary.
 */
import { el, heading, placeholder, displayLabel, technicalDetails, recordHref } from "./viewer-dom.js";

/** A raw source entry route; line spans are metadata for its read-only preview. */
function sourceHref(source) {
  const params = new URLSearchParams();
  const { start, end } = source.lines ?? {};
  if (validLines(start, end)) {
    params.set("start", String(start));
    params.set("end", String(end));
  }
  return `#/_source/${encodeURIComponent(source.file)}${params.size ? `?${params}` : ""}`;
}

/** Reject invalid line selections instead of constructing ambiguous source routes. */
function validLines(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start;
}

/** Build a text-only label or safe internally constructed navigation link. */
function entry(label, href) {
  const node = el(href ? "a" : "span", undefined, label);
  if (href) node.href = href;
  return node;
}

/** Render deterministic relation groups, naming any unresolved target. */
function appendRelations(section, context) {
  section.appendChild(heading("h2", "Connected records"));
  const relations = boundedEntries(context.relations);
  if (!relations.length) section.appendChild(placeholder("No connections recorded yet."));
  const groups = new Map();
  for (const relation of relations) {
    const key = `${relation.type} · ${relation.direction}`;
    if (!groups.has(key)) {
      section.appendChild(heading("h3", displayLabel(relation.type)));
      const list = el("ul");
      section.appendChild(list);
      groups.set(key, list);
    }
    groups.get(key).appendChild(relationItem(relation));
  }
  appendTruncation(section, relations.length, context.relationTotal, "relations");
}

/** One related endpoint retains an explicit unresolved label. */
function relationItem(relation) {
  const target = relation.target ?? {};
  const item = el("li");
  const verb = displayLabel(relation.type).toLowerCase();
  if (relation.direction === "outgoing") item.append(`This record ${verb} `);
  item.appendChild(entry(endpointLabel(target), target.resolved ? recordHref(target.id) : null));
  if (relation.direction === "incoming") item.append(` ${verb} this record.`);
  else if (relation.direction === "symmetric") item.append(` — ${verb} — this record.`);
  else item.append(".");
  item.title = `${relation.type} · ${relation.direction} · ${target.id ?? ""}`;
  if (!target.resolved) item.appendChild(el("span", "entity-field-unresolved", " Linked record not found or unavailable."));
  return item;
}

/** A title is preferred, with the durable identity retained as the fallback. */
function endpointLabel(target) {
  return target.title || target.id || "Unknown record";
}

/** Only credential-free http(s) connector origins become external links. */
function connectorHref(value) {
  try {
    const url = new URL(value);
    return safeConnector(url);
  } catch { return null; }
}

/** Never make local schemes or embedded credentials navigable. */
function safeConnector(url) {
  if (url.username || url.password) return null;
  return ["http:", "https:"].includes(url.protocol) ? url.href : null;
}

/** Keep the connector metadata fetch distinct from the original publication. */
function appendConnector(section, connector) {
  if (!connector) {
    section.appendChild(placeholder("No import history recorded."));
    return;
  }
  section.appendChild(heading("h3", "Where these details came from"));
  section.appendChild(el("p", undefined, `Record details imported from ${displayLabel(connector.connectorId)} on ${connector.fetchedAt}.`));
  const href = connectorHref(connector.sourceUrl);
  if (href) {
    const link = entry("View imported metadata (not the paper)", href);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    section.appendChild(link);
  }
  section.appendChild(el("p", undefined, "This link opens the imported descriptive data, not the original publication. It may be a machine-readable response rather than a reading page."));
  section.appendChild(technicalDetails(`Importer: ${connector.connectorId}\nVersion: ${connector.connectorVersion}\nContent hash: ${connector.contentHash}`));
}

/** Add evidence source-entry links without reading or rendering cited bytes. */
function appendEvidence(section, context) {
  section.appendChild(heading("h2", "Sources and supporting evidence"));
  appendConnector(section, context.connector);
  const sources = boundedEntries(context.sources);
  if (!sources.length) section.appendChild(placeholder("No supporting source passages linked yet."));
  const list = el("ul");
  for (const source of sources) list.appendChild(sourceItem(source));
  section.appendChild(list);
  appendTruncation(section, sources.length, context.sourceTotal, "source spans");
}

/** Apply the same defensive wire bound to both context collections. */
function boundedEntries(value) {
  return Array.isArray(value) ? value.slice(0, 100) : [];
}

/** Always disclose the true total when the view is truncated. */
function appendTruncation(section, shown, total, label) {
  if (total > shown) section.appendChild(el("p", undefined, `Showing ${shown} of ${total} ${label}.`));
}

/** One source entry exposes no local path or inferred original-publication URL. */
function sourceItem(source) {
  const item = el("li");
  const label = `${source.file}${source.lines ? `:${source.lines.start}-${source.lines.end}` : ""}`;
  item.appendChild(entry(label, source.resolved ? sourceHref(source) : null));
  if (!source.resolved) item.appendChild(el("span", "entity-field-unresolved", " — source file not found"));
  return item;
}

/** Render only typed pages carrying the server's context projection. */
export function renderEntityContext(main, payload) {
  if (!payload.entityType || !payload.entityContext) return;
  linkCitationChips(main);
  const section = el("section", "entity-context");
  section.setAttribute("data-entity-context", "");
  appendRelations(section, payload.entityContext);
  appendEvidence(section, payload.entityContext);
  main.appendChild(section);
}

/** Preserve claim-level positioning while giving resolved chips the source-entry route. */
function linkCitationChips(main) {
  for (const chip of main.querySelectorAll('.citation-chip[data-resolved="true"]')) {
    const file = chip.dataset.file;
    if (!file || /[\\/\u0000-\u001f]/.test(file)) continue;
    const lines = { start: Number(chip.dataset.lineStart), end: Number(chip.dataset.lineEnd) };
    chip.replaceChildren(entry(chip.textContent, sourceHref({ file, lines })));
  }
}
