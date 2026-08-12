/**
 * Shell-template loading and in-memory caching for the viewer's `GET /` handler.
 *
 * The template lives at `dist/viewer/assets/index.html` (copied there by
 * `scripts/copy-viewer-assets.mjs`) and is served verbatim: the shell carries no
 * per-request data.
 *
 * It used to. A `<!--PAGE_INDEX-->` marker was replaced per request with an
 * escaped `<script type="application/json" id="page-index">` blob carrying every
 * page's id, directory, slug, title and kind, so the sidebar could paint before
 * any fetch settled. The Nebula sidebar paints from an empty model instead
 * (`renderSidebar({})`) and fills itself from `/api/pages`, which left the blob
 * with no reader — a full page list serialized into every HTML response that
 * nothing parsed. It is gone rather than kept "in case": a second copy of the
 * page list on the wire is a second thing that can disagree with `/api/pages`.
 *
 * Lazy-read with process-local cache: a missing template is a per-request
 * 500 (`shell_missing`), not a startup failure. The viewer's API endpoints
 * stay usable even if the asset bundle is incomplete; only `GET /` degrades.
 */

import { readFile } from "fs/promises";
import path from "path";

/** Per-`assetsDir` template cache. `null` is cached too so the missing-template path doesn't hammer the disk. */
const templateCache = new Map<string, string | null>();

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
