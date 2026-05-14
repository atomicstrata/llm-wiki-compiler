/**
 * Path-confined static file server for the viewer's bundled assets.
 *
 * Owns three things:
 *   - `ASSETS_DIR` — the absolute filesystem path to the asset bundle,
 *     resolved once at module load from `import.meta.url`. The tsup
 *     `onSuccess` hook copies `src/viewer/assets/` here at build time.
 *   - The route handler for `GET /assets/*`: decode → `assertSafeSlug` →
 *     `realpath` → confine under `ASSETS_DIR` → extension allowlist.
 *   - The `ASSET_CONTENT_TYPES` allowlist that doubles as the
 *     served-extensions filter.
 *
 * `ASSETS_DIR` is exported because `src/viewer/server.ts`'s shell handler
 * also reads from the same directory via `loadShellTemplate`. Sharing the
 * constant keeps the two surfaces honest about pointing at one place.
 */

import { readFile, realpath } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { ServerResponse } from "http";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";

/**
 * Resolve the directory the viewer's static assets live in. Computed once
 * at module load, relative to wherever this file ended up after tsup
 * bundling — i.e. `<dist>/viewer/assets/` next to `dist/cli.js`. The
 * `copy-viewer-assets.mjs` tsup `onSuccess` hook is responsible for
 * populating that location; if it failed to run, the shell handler in
 * `server.ts` surfaces a per-request `shell_missing` 500 and this module
 * surfaces `asset_not_found` 404s instead of crashing startup.
 */
export const ASSETS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "viewer/assets",
);

/** Allowlist of asset extensions the static handler is willing to serve. */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Serve a single asset file from `ASSETS_DIR`. Path-confined to the
 * canonical assets dir (catching symlinked entries that try to escape)
 * and limited to the small extension allowlist in `ASSET_CONTENT_TYPES`.
 */
export async function handleAsset(res: ServerResponse, pathname: string): Promise<void> {
  const segments = decodeAssetSegments(pathname);
  if (!segments) {
    writeAssetError(res, 400, "bad_asset_path", "Bad asset path.");
    return;
  }
  if (segments.length === 0) {
    writeAssetError(res, 404, "asset_not_found", "Asset not found.");
    return;
  }
  const contentType = ASSET_CONTENT_TYPES[
    path.extname(segments[segments.length - 1]).toLowerCase()
  ];
  if (!contentType) {
    writeAssetError(res, 404, "asset_not_found", "Asset not found.");
    return;
  }
  const resolved = await resolveAssetPath(segments);
  if (!resolved) {
    writeAssetError(res, 404, "asset_not_found", "Asset not found.");
    return;
  }
  try {
    const body = await readFile(resolved);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.end(body);
  } catch {
    writeAssetError(res, 404, "asset_not_found", "Asset not found.");
  }
}

/**
 * Split the `/assets/...` URL path into decoded, structurally-safe
 * segments. Returns null when any segment is malformed (invalid
 * percent-encoding, separator, NUL, or traversal). An empty asset
 * path (`/assets/`) returns an empty array — the caller decides
 * whether to 404.
 */
function decodeAssetSegments(pathname: string): string[] | null {
  const trimmed = pathname.replace(/^\/assets\//, "");
  if (trimmed.length === 0) return [];
  const decoded: string[] = [];
  for (const raw of trimmed.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    try {
      assertSafeSlug(segment);
    } catch (err) {
      if (err instanceof PathSafetyError) return null;
      throw err;
    }
    decoded.push(segment);
  }
  return decoded;
}

/**
 * Join `segments` under `ASSETS_DIR`, `realpath` both sides, and return
 * the resolved path only when it stays inside the canonical assets dir.
 * Returns null when the file is missing or escapes confinement.
 */
async function resolveAssetPath(segments: string[]): Promise<string | null> {
  const candidate = path.join(ASSETS_DIR, ...segments);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return null;
  }
  const baseReal = await realpath(ASSETS_DIR).catch(() => ASSETS_DIR);
  if (resolved === baseReal) return resolved;
  const prefix = baseReal.endsWith(path.sep) ? baseReal : baseReal + path.sep;
  return resolved.startsWith(prefix) ? resolved : null;
}

/**
 * Write a `{ error: { code, message } }` JSON envelope for asset
 * failures. `message` is a hardcoded human string, never the request
 * pathname — reflecting untrusted input into the response body is
 * uneven with the rest of the server's error contract and would let
 * a noisy client write garbage into downstream response logs.
 */
function writeAssetError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { code, message } }));
}
