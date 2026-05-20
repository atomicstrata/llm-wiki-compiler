/**
 * Shell-template loading, in-memory caching, and page-index substitution
 * for the viewer's `GET /` handler.
 *
 * The template lives at `dist/viewer/assets/index.html` (copied there by
 * `scripts/copy-viewer-assets.mjs`) and contains a literal `<!--PAGE_INDEX-->`
 * marker the server replaces per-request with a `<script type="application/json"
 * id="page-index">…</script>` blob carrying a trimmed page list. The JSON is
 * escaped so `</`, `<!`, and bare `<` cannot break out of the embedded script
 * tag — this is the spec's "embed only as escaped JSON" allowance, executed
 * server-side rather than client-side.
 *
 * Lazy-read with process-local cache: a missing template is a per-request
 * 500 (`shell_missing`), not a startup failure. The viewer's API endpoints
 * stay usable even if the asset bundle is incomplete; only `GET /` degrades.
 */

import { readFile } from "fs/promises";
import path from "path";
import { resolvePageKind } from "./graph.js";
import type { ViewerPage } from "./types.js";

const PAGE_INDEX_MARKER = "<!--PAGE_INDEX-->";

/** Per-`assetsDir` template cache. `null` is cached too so the missing-template path doesn't hammer the disk. */
const templateCache = new Map<string, string | null>();

/** Page-index entry shape embedded in the shell. Excludes page bodies per spec. */
interface EmbeddedPage {
  id: string;
  pageDirectory: ViewerPage["pageDirectory"];
  slug: string;
  title: string;
  /** Frontmatter `kind`, used by the sidebar to group concepts on first paint. */
  kind: string;
}

/**
 * Read the shell template from `assetsDir/index.html`. Returns null when the
 * file is missing — the caller turns that into a `shell_missing` 500 so the
 * server keeps serving the rest of its routes. Caches the file bytes per
 * `assetsDir` in process memory; the cache is invalidated only by process
 * restart (consistent with the v1 "no live-watch" snapshot lifecycle).
 */
export async function loadShellTemplate(assetsDir: string): Promise<string | null> {
  const cached = templateCache.get(assetsDir);
  if (cached !== undefined) return cached;
  let bytes: string | null;
  try {
    bytes = await readFile(path.join(assetsDir, "index.html"), "utf-8");
  } catch {
    bytes = null;
  }
  templateCache.set(assetsDir, bytes);
  return bytes;
}

/** Clear the in-memory template cache. Tests use this between scenarios. */
export function resetShellTemplateCache(): void {
  templateCache.clear();
}

/**
 * Substitute the `<!--PAGE_INDEX-->` marker in `template` with a JSON-escaped
 * `<script type="application/json">` block carrying the trimmed page list.
 *
 * The embedded payload is a subset of `/api/pages.pages` — only the fields
 * the client needs for first-paint sidebar rendering. Page bodies are never
 * included. JSON serialization is followed by an HTML-safety pass that
 * replaces every literal less-than character with the JSON unicode escape
 * for less-than (backslash-u-003c), so a `</script>` substring, a `<!`
 * sequence, or bare angle brackets in any page title cannot break out of
 * the embedded tag. `JSON.parse` on the client round-trips that escape
 * back into a literal less-than character.
 */
export function substitutePageIndex(template: string, pages: ViewerPage[]): string {
  const embedded: EmbeddedPage[] = pages.map((page) => ({
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    kind: resolvePageKind(page.frontmatter),
  }));
  const json = JSON.stringify({ pages: embedded }).replace(/</g, "\\u003c");
  const block = `<script type="application/json" id="page-index">${json}</script>`;
  return template.replace(PAGE_INDEX_MARKER, block);
}
