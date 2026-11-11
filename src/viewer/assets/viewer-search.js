/**
 * llmwiki viewer — header search UI.
 *
 * Wires the search input in the shell template (now in the header's
 * `.app-actions`, beside the theme toggle — moved out of the sidebar so it
 * reads as a global action rather than page-tree navigation) to
 * `/api/search?q=...`. Input is debounced before each fetch (spec §Slice 5
 * acceptance: "client input is debounced before calling `/api/search`").
 * The results <ul> doubles as a focus-cyclable result list: ArrowDown from
 * the input jumps to the first result; ArrowUp/Down within results cycles;
 * Escape returns focus to the input; Enter activates the focused anchor
 * (the browser handles `<a href="#/...">` activation natively, so we
 * don't intercept it). A global ⌘K / Ctrl+K shortcut focuses the input
 * from anywhere — see `wireSearchShortcut`.
 *
 * Imported by `viewer.js` and invoked from `main()` after the sidebar
 * first paint. Keeps the entry file small (CLAUDE.md 400-LOC rule) and
 * isolates the keyboard-navigation surface for unit testing.
 */

const SEARCH_INPUT_SELECTOR = "[data-search-input]";
const SEARCH_RESULTS_SELECTOR = "[data-search-results]";
const SEARCH_DEBOUNCE_MS = 200;

/**
 * Wire the search input + results panel. Idempotent: calling more than
 * once attaches multiple listeners, so call exactly once in bootstrap.
 * Returns silently when either the input or results element is missing
 * (the shell template owns those selectors).
 *
 * Concurrency contract: a monotonically increasing `generation` counter
 * (bumped on every input event) gates BOTH the pending-debounce timer
 * AND any in-flight `fetch`. An older response that arrives after the
 * user has cleared the input or typed a newer query is discarded
 * silently — the results panel only ever reflects the most recent
 * input-vs-render decision.
 */
export function wireSearch({ fetchJson }) {
  const input = document.querySelector(SEARCH_INPUT_SELECTOR);
  const results = document.querySelector(SEARCH_RESULTS_SELECTOR);
  if (!input || !results) return;
  let currentGeneration = 0;
  let pendingTimer = 0;
  const cancelPending = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
  };
  input.addEventListener("input", () => {
    currentGeneration += 1;
    cancelPending();
    const value = input.value.trim();
    if (value.length === 0) {
      hideSearchResults(results);
      return;
    }
    const generation = currentGeneration;
    pendingTimer = setTimeout(() => {
      pendingTimer = 0;
      void runSearchAndRender(value, results, fetchJson, () => generation === currentGeneration);
    }, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => onSearchInputKeydown(event, results));
  results.addEventListener("keydown", (event) => onSearchResultsKeydown(event, input));
  results.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("a")) {
      currentGeneration += 1;
      cancelPending();
      hideSearchResults(results);
      input.value = "";
    }
  });
  wireSearchShortcut(input);
}

/**
 * Global ⌘K / Ctrl+K shortcut: focuses the search input and selects its
 * contents so typing immediately replaces whatever query was there. The
 * header chip beside the input advertises this shortcut, so it must be
 * real (see file header). Suppressed while focus already sits in a
 * DIFFERENT text-entry surface — another input, a textarea, or a
 * contenteditable — so the shortcut can't steal a keystroke from
 * unrelated typing; re-triggering it while the search input itself is
 * already focused is harmless (it just re-selects) and stays allowed.
 */
function wireSearchShortcut(input) {
  document.addEventListener("keydown", (event) => {
    if (!isSearchShortcutCombo(event)) return;
    if (isOtherTypingSurface(event.target, input)) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
}

/** True when the event's key + modifiers form the ⌘K / Ctrl+K combo. */
function isSearchShortcutCombo(event) {
  if (event.key.toLowerCase() !== "k") return false;
  return event.metaKey || event.ctrlKey;
}

/** Tag names that make an element a text-entry surface on their own. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA"]);

/** True when `target` is a real element the user can type into (tag or contenteditable). */
function isTypingSurface(target) {
  if (!(target instanceof HTMLElement)) return false;
  return TYPING_TAGS.has(target.tagName) || target.isContentEditable;
}

/** True when `target` is a different typing surface than `input` — the shortcut must not hijack it. */
function isOtherTypingSurface(target, input) {
  return target !== input && isTypingSurface(target);
}

/**
 * Fetch /api/search for `query` and render the results list, but only
 * when `stillCurrent()` returns true at the moment the response
 * resolves. A later-typed query supersedes an earlier one regardless
 * of which network response arrives first.
 *
 * Search-failure UX intentionally stays inline in the results panel
 * (rather than blowing away the main pane) so an ephemeral network
 * blip doesn't drop the user out of the page they're reading.
 */
async function runSearchAndRender(query, results, fetchJson, stillCurrent) {
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
    handleSearchSuccess(data, results, stillCurrent);
  } catch (err) {
    handleSearchFailure(err, results, stillCurrent);
  }
}

/** Render the response rows when the user hasn't moved past this query yet. */
function handleSearchSuccess(data, results, stillCurrent) {
  if (!stillCurrent()) return;
  renderSearchResults(data.results ?? [], results);
}

/** Show an inline error in the results panel when the search fetch threw. */
function handleSearchFailure(err, results, stillCurrent) {
  if (!stillCurrent()) return;
  results.innerHTML = "";
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = `Search failed: ${err.message}`;
  results.appendChild(li);
  results.hidden = false;
}

/** Render rows into the results <ul>; show an "empty" message for zero hits. */
function renderSearchResults(rows, results) {
  results.innerHTML = "";
  results.hidden = false;
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No matches.";
    results.appendChild(li);
    return;
  }
  for (const row of rows) results.appendChild(buildSearchResultRow(row));
}

/**
 * The kind tag for one result.
 *
 * `entityType` is present only on a profile project's typed entity pages, and
 * it is the type the profile declares — so a newsroom article reads "articles"
 * rather than being flattened into the default profile's vocabulary. Without
 * it this was a two-way test (`queries` → query, EVERYTHING ELSE → concept),
 * which badged every typed page a concept even though the payload had carried
 * the right answer since the typed pages landed.
 *
 * The literal type id is used rather than the nav's title-cased label,
 * matching the design's rule that provenance surfaces keep the profile's own
 * identifier while only the nav title-cases it.
 *
 * @param {{entityType?: string, pageDirectory?: string}} row - A search result.
 * @returns {string}
 */
function resultKindLabel(row) {
  if (typeof row.entityType === "string" && row.entityType.length > 0) return row.entityType;
  return DIRECTORY_KIND_LABELS[row.pageDirectory] ?? "concept";
}

/** The kind tag of a default page by its directory; anything else reads as a concept. */
const DIRECTORY_KIND_LABELS = { queries: "query", timeline: "timeline" };

/** Build one search-result <li> with anchor + kind tag + snippet. */
function buildSearchResultRow(row) {
  const li = document.createElement("li");
  li.setAttribute("role", "option");
  const link = document.createElement("a");
  const slug = deriveSlug(row.id);
  link.href = `#/${encodeURIComponent(row.pageDirectory)}/${encodeURIComponent(slug)}`;
  link.dataset.searchResult = "true";
  const kind = document.createElement("span");
  kind.className = "result-kind";
  kind.textContent = resultKindLabel(row);
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = row.title || row.id;
  const snippet = document.createElement("span");
  snippet.className = "result-snippet";
  snippet.textContent = cleanSnippet(row.snippet || "");
  link.appendChild(kind);
  link.appendChild(title);
  link.appendChild(snippet);
  li.appendChild(link);
  return li;
}

/** Mirror server-side snippet cleanup so existing viewer processes improve after asset reload. */
function cleanSnippet(value) {
  return value
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1");
}

/** Extract the slug from a PageId of the form `concepts/<slug>`. */
function deriveSlug(id) {
  const slash = String(id).indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Hide the results panel. */
function hideSearchResults(results) {
  results.innerHTML = "";
  results.hidden = true;
}

/** ArrowDown from the search input moves focus to the first result anchor. */
function onSearchInputKeydown(event, results) {
  if (event.key !== "ArrowDown") return;
  const first = results.querySelector("a[data-search-result]");
  if (!first) return;
  event.preventDefault();
  first.focus();
}

/** ArrowUp/Down within results cycle focus; Escape returns focus to input. */
function onSearchResultsKeydown(event, input) {
  if (event.key === "Escape") {
    handleSearchEscape(event, input);
    return;
  }
  const direction = arrowDirection(event.key);
  if (!direction) return;
  const target = anchorTarget(event.target);
  if (!target) return;
  event.preventDefault();
  focusNeighborAnchor(target, direction);
}

/** Bounce focus back to the search input on Escape. */
function handleSearchEscape(event, input) {
  event.preventDefault();
  input.focus();
}

/** Map ArrowDown/ArrowUp to +1/-1; return 0 for any other key. */
function arrowDirection(key) {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  return 0;
}

/** Narrow an EventTarget to an HTMLAnchorElement, or null when it isn't one. */
function anchorTarget(target) {
  return target instanceof HTMLAnchorElement ? target : null;
}

/** Wrap focus across the result anchors by `direction` (+1 or -1). */
function focusNeighborAnchor(target, direction) {
  const all = Array.from(target.closest("ul").querySelectorAll("a[data-search-result]"));
  if (all.length === 0) return;
  const idx = all.indexOf(target);
  const next = all[(idx + direction + all.length) % all.length];
  if (next) next.focus();
}
