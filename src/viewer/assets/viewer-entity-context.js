/**
 * Read-only entity relations and evidence from the frozen page projection.
 * Labels always use textContent. Navigation is constructed from identifiers;
 * connector URLs are checked independently at this browser boundary.
 */
import { el, heading, placeholder } from "./viewer-dom.js";

/** A profile entity route from its qualified identity, never a supplied URL. */
function entityHref(id) {
  if (typeof id !== "string") return null;
  const parts = id.split("/");
  return parts.length === 2 && parts.every(Boolean) ? `#/${parts.map(encodeURIComponent).join("/")}` : null;
}

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
  section.appendChild(heading("h2", "Related entities"));
  const relations = boundedEntries(context.relations);
  if (!relations.length) section.appendChild(placeholder("No relations attached."));
  const groups = new Map();
  for (const relation of relations) {
    const key = `${relation.type} · ${relation.direction}`;
    if (!groups.has(key)) {
      section.appendChild(heading("h3", key));
      const list = el("ul");
      section.appendChild(list);
      groups.set(key, list);
    }
    groups.get(key).appendChild(relationItem(relation.target));
  }
  appendTruncation(section, relations.length, context.relationTotal, "relations");
}

/** One related endpoint retains an explicit unresolved label. */
function relationItem(target = {}) {
  const item = el("li");
  item.appendChild(entry(endpointLabel(target), target.resolved ? entityHref(target.id) : null));
  if (!target.resolved) item.appendChild(el("span", "entity-field-unresolved", " — unresolved endpoint"));
  return item;
}

/** A title is preferred, with the durable identity retained as the fallback. */
function endpointLabel(target) {
  return target.title || target.id || "Unknown entity";
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
    section.appendChild(placeholder("No connector metadata attached."));
    return;
  }
  section.appendChild(heading("h3", "Connector metadata fetch"));
  section.appendChild(el("p", undefined, `${connector.connectorId} ${connector.connectorVersion} · fetched ${connector.fetchedAt}`));
  const href = connectorHref(connector.sourceUrl);
  if (href) {
    const link = entry("Metadata source", href);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    section.appendChild(link);
  }
  section.appendChild(el("p", undefined, `Content hash: ${connector.contentHash}`));
  section.appendChild(el("p", undefined, "This identifies the metadata fetch, not the original publication."));
}

/** Add evidence source-entry links without reading or rendering cited bytes. */
function appendEvidence(section, context) {
  section.appendChild(heading("h2", "Provenance and evidence"));
  appendConnector(section, context.connector);
  const sources = boundedEntries(context.sources);
  if (!sources.length) section.appendChild(placeholder("No source evidence attached."));
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
  if (!source.resolved) item.appendChild(el("span", "entity-field-unresolved", " — unresolved source"));
  return item;
}

/** A source entry is snapshot metadata, not a read of the source file. */
export function renderSourceEntry(main, envelope, filename) {
  main.replaceChildren(heading("h1", filename));
  const present = envelope?.sourceFilenames?.includes(filename);
  main.appendChild(el("p", undefined, present ? "Raw ingested source entry" : "Unresolved source entry"));
  main.appendChild(placeholder("Content preview is not available in this view."));
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
