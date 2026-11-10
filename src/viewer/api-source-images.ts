/**
 * Read-only image route for originals kept beside ingested sources.
 *
 * A source can keep its original images (screenshots, photos, scans) in
 * `sources/images/`. `GET /api/source-image/<file>` serves one of them so a
 * viewer can show the original next to the text the wiki cites.
 *
 * The route follows the same content rules as `/api/source/<id>/content`:
 * bytes are served on a loopback binding only, and every request re-reads the
 * file through a confined, capped, no-follow handle. The name is one decoded
 * path segment checked by `assertSafeSlug`, and only raster image extensions
 * are served. SVG is deliberately absent: it can carry script.
 */

import path from "path";
import type { ServerResponse } from "http";
import { readConfinedCappedBuffer } from "../sdk/domain-read.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";
import { writeJsonError } from "./respond.js";

/** URL prefix of the route; the remainder is one encoded file name. */
export const SOURCE_IMAGE_ROUTE_PREFIX = "/api/source-image/";

/** Directory, relative to the project root, that holds source images. */
const SOURCE_IMAGE_DIRECTORY = path.join("sources", "images");

/** Largest image the route will read into memory. */
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Served extensions and their content types; doubles as the allowlist. */
const SOURCE_IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Serve one image from `sources/images/`, or a JSON error envelope. */
export async function handleApiSourceImage(
  res: ServerResponse,
  root: string,
  pathname: string,
  isLoopback: boolean,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (!isLoopback) {
    writeJsonError(res, 403, "loopback_required", "Content is available only on a loopback binding.");
    return;
  }
  const file = decodeImageName(pathname);
  const contentType = file === null ? undefined : SOURCE_IMAGE_CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (file === null || contentType === undefined) {
    writeJsonError(res, 400, "invalid_source_image", "Invalid source image name.");
    return;
  }
  const directory = path.join(root, SOURCE_IMAGE_DIRECTORY);
  const read = await readConfinedCappedBuffer(root, path.join(directory, file), directory, MAX_SOURCE_IMAGE_BYTES);
  if (read.kind !== "ok") {
    writeJsonError(res, 404, "source_image_not_found", "Source image not found.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.end(read.body);
}

/** Decode the single file-name segment, or null when it is not one safe segment. */
function decodeImageName(pathname: string): string | null {
  const encoded = pathname.slice(SOURCE_IMAGE_ROUTE_PREFIX.length);
  try {
    const file = decodeURIComponent(encoded);
    assertSafeSlug(file);
    return file;
  } catch (error) {
    if (error instanceof PathSafetyError || error instanceof URIError) return null;
    throw error;
  }
}
