/**
 * llmwiki viewer — shared DOM element builders.
 *
 * Every render module builds its DOM through these four helpers rather than
 * hand-rolling `document.createElement` chains. Centralising them keeps the
 * render modules short and, more importantly, keeps text insertion on
 * `textContent` — the server is the only component permitted to produce
 * markup, and it sanitises before doing so.
 *
 * No module in this bundle may set `innerHTML` on content it did not receive
 * from the server's sanitised `html` field.
 */

/**
 * Build an element with an optional class and text content.
 *
 * @param {string} tag - Tag name.
 * @param {string} [className] - Class attribute; omitted entirely when absent.
 * @param {string} [text] - Text content, inserted via textContent.
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build a heading element.
 *
 * @param {string} tag - Heading tag, e.g. "h1".
 * @param {string} text - Heading text.
 * @returns {HTMLElement}
 */
export function heading(tag, text) {
  return el(tag, undefined, text);
}

/** Readable labels without changing stored identifiers or interpreting domain values. */
export function displayLabel(value) {
  const text = String(value ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  if (/^(doi|url|id|api)$/i.test(text)) return text.toUpperCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Keep exact diagnostic data available without making it the reading surface. */
export function technicalDetails(text) {
  const details = el("details", "technical-details");
  details.append(el("summary", undefined, "Technical details"), el("pre", undefined, text));
  return details;
}

/** Build a record link from its qualified identity, never an arbitrary supplied URL. */
export function recordHref(id) {
  if (typeof id !== "string") return null;
  const parts = id.split("/");
  return parts.length === 2 && parts.every(Boolean) ? `#/${parts.map(encodeURIComponent).join("/")}` : null;
}

/**
 * Build the standard italic placeholder paragraph used for empty states.
 *
 * @param {string} text - Message to display.
 * @returns {HTMLElement}
 */
export function placeholder(text) {
  return el("p", "placeholder", text);
}

/**
 * Build the design system's empty state: a dashed-border card that teaches the
 * concept and, where one exists, gives the exact command to fix it.
 *
 * Italic placeholder text is NOT an empty state — it says a surface is blank
 * without saying what would fill it. Use `placeholder` only for transient
 * loading text.
 *
 * @param {string} title - What is missing, stated plainly.
 * @param {string} body - Why the surface exists and what would fill it.
 * @param {string} [command] - The exact CLI command, lowercase.
 * @returns {HTMLElement}
 */
export function emptyState(title, body, command) {
  const wrap = el("div", "empty-state");
  wrap.appendChild(el("div", "empty-state-title", title));
  wrap.appendChild(el("div", "empty-state-body", body));
  if (command) wrap.appendChild(el("div", "empty-state-command", command));
  return wrap;
}
