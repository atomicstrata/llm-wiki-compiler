/**
 * Read-only source and artifact detail views. Responses are rendered as inert
 * text; each preview fetch rechecks content rather than trusting earlier health.
 */
import { el } from "./viewer-dom.js";

/** Populate a detached-per-route container so late responses cannot overwrite another page. */
export async function renderSourceDetail(main, route) {
  const section = el("section", "source-detail");
  main.replaceChildren(section);
  const endpoint = `/api/source/${encodeURIComponent(route.filename)}`;
  try {
    const metadata = await fetchMetadata(endpoint);
    section.appendChild(el("h1", "page-title", metadata.title || route.filename));
    section.appendChild(el("p", "source-description", "Raw ingested source — not a typed source entity or necessarily the original publication."));
    appendMetadata(section, metadata);
    if (metadata.health !== "ok") return;
    if (metadata.contentAccess !== "available") {
      section.appendChild(el("p", "source-access-note", "Content preview requires a loopback binding."));
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
  if (!allRefs.length && context) context.appendChild(el("p", "artifact-empty", "No artifacts attached."));
  const refs = allRefs.slice(0, 100);
  if (allRefs.length > refs.length && context) context.appendChild(el("p", "artifact-limit", `Verifying ${refs.length} of ${allRefs.length} artifact references; remaining references are unverified.`));
  for (const ref of refs) {
    const endpoint = `/api/artifact?ref=${encodeURIComponent(ref.textContent)}`;
    const panel = el("div", "artifact-detail");
    ref.after(panel);
    try {
      const metadata = await fetchMetadata(endpoint);
      appendMetadata(panel, metadata);
      if (metadata.health === "ok" && metadata.contentAccess === "available") artifactControls(panel, ref.textContent);
      else if (metadata.contentAccess === "loopback-only") panel.appendChild(el("span", "artifact-access-note", " Preview requires loopback."));
      ref.closest("dd")?.querySelector(".entity-field-unresolved")?.remove();
    } catch { panel.appendChild(el("span", "artifact-health", " Verification unavailable")); }
  }
}

/** Explicit allowlist excludes internal fields and bodies from metadata rendering. */
function appendMetadata(container, value) {
  const list = el("dl", "access-metadata");
  for (const key of ["health", "fileName", "sourceType", "ingestedAt", "locator", "manifest", "metadata"]) {
    if (value[key] === undefined) continue;
    list.appendChild(el("dt", "access-label", key));
    const cell = el("dd", "access-value");
    const text = typeof value[key] === "object" ? JSON.stringify(value[key]) : String(value[key]);
    if (key === "locator" && safeLocator(text)) {
      const link = el("a", "source-locator", text);
      link.href = text; link.target = "_blank"; link.rel = "noopener noreferrer";
      cell.appendChild(link);
    } else cell.textContent = text;
    list.appendChild(cell);
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
