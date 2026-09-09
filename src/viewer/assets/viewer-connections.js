/** Human-readable connection definitions with on-demand access to frozen graph records. */
import { el, displayLabel, recordHref, technicalDetails } from "./viewer-dom.js";

const CONNECTION_LIMIT = 100;

/** Separate supported connection types from the actual record inventory. */
export function buildConnections(declared) {
  const relations = declared ?? [];
  const section = el("details", "pipeline-relations");
  section.append(el("summary", undefined, "How records connect"));
  section.append(el("p", "pipeline-relations-note", "These are the connections this project supports. Counts show links currently recorded. Open a count to inspect the connected records."));
  const table = el("table", "pipeline-relation-chips");
  const head = el("thead");
  const row = el("tr");
  for (const label of ["Relationship", "Connects", "Recorded links"]) {
    const cell = el("th", undefined, label);
    cell.scope = "col";
    row.append(cell);
  }
  head.append(row);
  const body = el("tbody");
  for (const relation of relations) body.append(buildConnectionRow(relation));
  table.append(head, body);
  section.append(table);
  if (!relations.length) section.append(el("p", undefined, "No connection types configured."));
  section.append(technicalDetails(JSON.stringify(relations.map(({ type, from, to, direction }) => ({ type, from, to, direction })), null, 2)));
  return section;
}

/** A readable definition retains its exact key as a diagnostic tooltip. */
function buildConnectionRow(relation) {
  const row = el("tr", "pipeline-relation-chip");
  row.dataset.relationType = relation.type;
  row.title = relation.type;
  row.append(el("td", "pipeline-relation-name", displayLabel(relation.type)));
  const endpoints = el("td");
  endpoints.append(el("span", "pipeline-relation-endpoint", (relation.from ?? []).map(displayLabel).join(" or ")));
  endpoints.append(el("span", "pipeline-relation-arrow", relation.direction === "symmetric" ? " ↔ " : " → "));
  endpoints.append(el("span", "pipeline-relation-endpoint", (relation.to ?? []).map(displayLabel).join(" or ")));
  row.append(endpoints, buildCountCell(relation));
  return row;
}

/** Only positive counts offer inspection; each request remains read-only. */
function buildCountCell(relation) {
  const cell = el("td", "pipeline-relation-count");
  if (!(relation.count > 0)) { cell.append("No links yet"); return cell; }
  const button = el("button", "connection-open", `${relation.count} recorded ${relation.count === 1 ? "link" : "links"}`);
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const output = el("div", "connection-records");
  output.hidden = true;
  button.addEventListener("click", async () => {
    output.hidden = !output.hidden;
    button.setAttribute("aria-expanded", String(!output.hidden));
    if (output.hidden) return;
    button.disabled = true;
    try { await loadConnections(output, relation.type); }
    finally { button.disabled = false; }
  });
  cell.append(button, output);
  return cell;
}

/** Use the existing snapshot graph, retaining missing endpoints and bounded output. */
async function loadConnections(output, type) {
  output.replaceChildren(el("p", undefined, "Loading connected records…"));
  try {
    const response = await fetch("/api/graph");
    if (!response.ok) throw new Error("Graph unavailable");
    const graph = await response.json();
    const edges = graph.edges.filter((edge) => edge.edgeKind === "relation" && edge.relationType === type);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const list = el("ul");
    for (const edge of edges.slice(0, CONNECTION_LIMIT)) {
      const item = el("li");
      item.append(connectionEndpoint(edge.source, nodes), edge.direction === "symmetric" ? " ↔ " : " → ", connectionEndpoint(edge.target, nodes));
      list.append(item);
    }
    output.replaceChildren(list);
    if (!edges.length) output.append(el("p", undefined, "No recorded links available in this snapshot."));
    if (edges.length > CONNECTION_LIMIT) output.append(el("p", undefined, `Showing ${CONNECTION_LIMIT} of ${edges.length} links.`));
  } catch { output.replaceChildren(el("p", undefined, "Connections could not be loaded. Close and reopen this count to try again.")); }
}

/** A missing graph endpoint remains visible but never becomes a dead navigation link. */
function connectionEndpoint(id, nodes) {
  const node = nodes.get(id);
  const href = node && !node.isDangling ? recordHref(id) : null;
  const label = node?.title || id;
  const entry = el(href ? "a" : "span", undefined, href ? label : `${label} (record not found or unavailable)`);
  if (href) entry.href = href;
  return entry;
}
