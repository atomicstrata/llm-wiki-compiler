/**
 * Read-only source and artifact detail views. Responses are rendered as inert
 * text; each preview fetch rechecks content rather than trusting earlier health.
 */
import { el, displayLabel, technicalDetails } from "./viewer-dom.js";

const FILE_HEALTH_LABELS = Object.assign(Object.create(null), {
  ok: "Passed", missing: "Source file not found", unsupported: "This file type cannot be previewed",
  unavailable: "Source file could not be read", "artifact-dangling": "Attached file not found",
  "artifact-unreadable": "Attached file could not be read", "artifact-bytes-tampered": "File contents have changed",
  "artifact-schema-invalid": "File contents do not match the expected format",
  "artifact-hash-mismatch": "File does not match the attached version",
  "artifact-store-unavailable": "File storage could not be verified",
});

/** Populate a detached-per-route container so late responses cannot overwrite another page. */
export async function renderSourceDetail(main, route) {
  const section = el("section", "source-detail");
  main.replaceChildren(section);
  const endpoint = `/api/source/${encodeURIComponent(route.filename)}`;
  try {
    const metadata = await fetchMetadata(endpoint);
    section.appendChild(el("h1", "page-title", metadata.title || route.filename));
    section.appendChild(el("p", "source-description", "Source text used by the wiki. This may be an imported text copy rather than the original document."));
    appendMetadata(section, metadata);
    if (metadata.health !== "ok") return;
    if (metadata.contentAccess !== "available") {
      section.appendChild(el("p", "source-access-note", "To preview files, run the viewer bound to localhost on the computer storing this project. Network-shared viewers show file details only."));
      return;
    }
    const body = await fetchContent(`${endpoint}/content`);
    section.appendChild(numberedSource(body, route));
  } catch {
    section.appendChild(el("p", "source-access-error", "Source content unavailable. The entry may have changed since this snapshot."));
  }
}

/** Keep line numbers physical, including frontmatter; ignore invalid selection ranges. */
function numberedSource(body, route) {
  const pre = el("pre", "source-preview");
  const start = Number.isSafeInteger(route.start) && route.start > 0 ? route.start : undefined;
  const end = Number.isSafeInteger(route.end) && route.end >= start ? route.end : start;
  const lines = body.split("\n").map((line, index) => `${index + 1}  ${line}\n`);
  // Three nodes at most: a newline-heavy in-cap file must not create a million DOM nodes.
  if (start === undefined || start > lines.length) pre.textContent = lines.join("");
  else {
    pre.appendChild(document.createTextNode(lines.slice(0, start - 1).join("")));
    pre.appendChild(el("mark", "source-line", lines.slice(start - 1, end).join("")));
    pre.appendChild(document.createTextNode(lines.slice(end).join("")));
  }
  return pre;
}

/** Resolve a bounded set of the profile field renderer's explicit artifact slots. */
export async function decorateArtifactRefs(main, _payload) {
  const allRefs = [...main.querySelectorAll(".entity-field-ref")];
  const context = main.querySelector("[data-entity-context]");
  if (!allRefs.length && context) context.appendChild(el("p", "artifact-empty", "No files attached."));
  const refs = allRefs.slice(0, 100);
  if (allRefs.length > refs.length && context) context.appendChild(el("p", "artifact-limit", `Checking ${refs.length} of ${allRefs.length} attached files; remaining files have not been checked.`));
  for (const ref of refs) {
    const endpoint = `/api/artifact?ref=${encodeURIComponent(ref.textContent)}`;
    const panel = el("div", "artifact-detail");
    ref.after(panel);
    const rawRef = ref.textContent;
    const details = technicalDetails("File reference:");
    details.appendChild(ref);
    try {
      const metadata = await fetchMetadata(endpoint);
      panel.appendChild(el("h3", "attachment-name", metadata.fileName || "Attached file"));
      appendMetadata(panel, metadata);
      if (metadata.health === "ok" && metadata.contentAccess === "available") artifactControls(panel, rawRef);
      else if (metadata.contentAccess === "loopback-only") panel.appendChild(el("span", "artifact-access-note", " To preview, run the viewer bound to localhost on the computer storing this project."));
      panel.closest("dd")?.querySelector(".entity-field-unresolved")?.remove();
    } catch { panel.appendChild(el("span", "artifact-health", " File could not be checked. Try reopening this record.")); }
    panel.appendChild(details);
  }
}

/** Explicit allowlist excludes internal fields and bodies from metadata rendering. */
function appendMetadata(container, value) {
  const list = el("dl", "access-metadata");
  for (const key of ["health", "sourceType", "ingestedAt", "locator"]) {
    if (value[key] === undefined) continue;
    list.appendChild(el("dt", "access-label", accessLabel(key)));
    const cell = el("dd", "access-value");
    const text = typeof value[key] === "object" ? JSON.stringify(value[key]) : String(value[key]);
    if (key === "locator" && safeLocator(text)) {
      const link = el("a", "source-locator", text);
      link.href = text; link.target = "_blank"; link.rel = "noopener noreferrer";
      cell.appendChild(link);
    } else cell.textContent = key === "health" ? fileHealth(text) : text;
    cell.title = `${key}: ${text}`;
    list.appendChild(cell);
  }
  container.appendChild(list);
  if (value.metadata) appendFileMetadata(container, value.metadata);
  if (value.manifest) container.appendChild(technicalDetails(JSON.stringify(value.manifest, null, 2)));
}

/** Explain file checks without equating an unknown status with verified content. */
function fileHealth(health) {
  return FILE_HEALTH_LABELS[health] ?? "File could not be verified";
}

/** Reader-facing file labels; the locator is not assumed to be a publication. */
function accessLabel(key) {
  return { health: "File check", sourceType: "Source type", ingestedAt: "Imported", locator: "Recorded source link" }[key];
}

/** Render only metadata the server already allowed, with readable field labels. */
function appendFileMetadata(container, metadata) {
  const list = el("dl", "access-metadata");
  for (const [key, value] of Object.entries(metadata)) {
    list.append(el("dt", undefined, displayLabel(key)), el("dd", undefined, typeof value === "object" ? JSON.stringify(value) : String(value)));
  }
  container.appendChild(list);
}

/** Validate again at the client boundary before making an external navigation. */
function safeLocator(text) {
  try { const url = new URL(text); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

/** No HTML render path: even Markdown artifacts preview as text. */
function artifactControls(panel, ref) {
  const endpoint = `/api/artifact/content?ref=${encodeURIComponent(ref)}`;
  const button = el("button", "artifact-preview-button", "Preview");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { panel.appendChild(el("pre", "artifact-preview", await fetchContent(endpoint))); }
    catch { panel.appendChild(el("span", "artifact-health", " Content changed or is unavailable.")); }
  });
  const download = el("a", "artifact-download", "Download");
  download.href = `${endpoint}&download=1`;
  panel.append(button, download);
}

/** Fetch current metadata without retaining successful health in a browser cache. */
async function fetchMetadata(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Metadata unavailable");
  return response.json();
}

/** The server verifies each independent content request. */
async function fetchContent(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Content unavailable");
  return response.text();
}
