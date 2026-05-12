/**
 * llmwiki viewer — sidebar search UI.
 *
 * Wires the search input in the shell template to `/api/search?q=...`.
 * Input is debounced before each fetch (spec §Slice 5 acceptance:
 * "client input is debounced before calling `/api/search`"). The
 * sidebar's results <ul> doubles as a focus-cyclable result list:
 * ArrowDown from the input jumps to the first result; ArrowUp/Down
 * within results cycles; Escape returns focus to the input; Enter
 * activates the focused anchor (the browser handles `<a href="#/...">`
 * activation natively, so we don't intercept it).
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
export function wireSearch({ fetchJson, renderError }) {
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
      void runSearchAndRender(value, results, fetchJson, renderError, () => generation === currentGeneration);
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
}

/**
 * Fetch /api/search for `query` and render the results list, but only
 * when `stillCurrent()` returns true at the moment the response
 * resolves. A later-typed query supersedes an earlier one regardless
 * of which network response arrives first.
 */
async function runSearchAndRender(query, results, fetchJson, renderError, stillCurrent) {
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
    if (!stillCurrent()) return;
    renderSearchResults(data.results ?? [], results);
  } catch (err) {
    void renderError;
    if (!stillCurrent()) return;
    results.innerHTML = "";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `Search failed: ${err.message}`;
    results.appendChild(li);
    results.hidden = false;
  }
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
  kind.textContent = row.pageDirectory === "queries" ? "query" : "concept";
  const title = document.createElement("span");
  title.className = "result-title";
  title.textContent = row.title || row.id;
  const snippet = document.createElement("span");
  snippet.className = "result-snippet";
  snippet.textContent = row.snippet || "";
  link.appendChild(kind);
  link.appendChild(title);
  link.appendChild(snippet);
  li.appendChild(link);
  return li;
}

/** Extract the slug from a PageId of the form `concepts/<slug>`. */
function deriveSlug(id) {
  const slash = String(id).indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Hide the results panel and restore the standing sidebar contents. */
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
    event.preventDefault();
    input.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const target = event.target instanceof HTMLAnchorElement ? event.target : null;
  if (!target) return;
  event.preventDefault();
  const all = Array.from(target.closest("ul").querySelectorAll("a[data-search-result]"));
  const idx = all.indexOf(target);
  const next = event.key === "ArrowDown"
    ? all[(idx + 1) % all.length]
    : all[(idx - 1 + all.length) % all.length];
  if (next) next.focus();
}
