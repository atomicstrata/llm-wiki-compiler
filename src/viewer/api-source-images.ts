/**
 * Read-only route for the original images a source declares.
 *
 * `GET /api/source-image/<source>/<file>` serves `sources/images/<file>` only
 * when `<source>` is a source in the snapshot that declares `<file>` in its
 * frontmatter `images:` list. An image is therefore reachable exactly as long
 * as a source that owns it is: a file left in the directory after its source
 * is removed is not served.
 *
 * The route follows the same content rules as `/api/source/<id>/content`:
 * bytes are served on a loopback binding only, and every request re-reads the
 * source and the image through confined, capped handles.
 */

import path from "path";
import type { ServerResponse } from "http";
import { readConfinedCappedBuffer } from "../sdk/domain-read.js";
import { PathSafetyError } from "./path-safety.js";
import { writeJsonError } from "./respond.js";
import { readViewerSource } from "./source-access.js";
import { isSourceImageName, sourceImageContentType } from "./source-image-names.js";
import type { ViewerSnapshot } from "./types.js";

/** URL prefix of the route; the remainder is `<source>/<file>`, each segment encoded. */
export const SOURCE_IMAGE_ROUTE_PREFIX = "/api/source-image/";

/** Directory, relative to the project root, that holds source images. */
const SOURCE_IMAGE_DIRECTORY = path.join("sources", "images");

/** Largest image the route will read into memory. */
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** The source and image a request names. */
interface SourceImageTarget {
  sourceId: string;
  file: string;
}

/** What the route needs from the snapshot: the root and the frozen source allowlist. */
type SourceImageSnapshot = Pick<ViewerSnapshot, "root" | "sourceFilenames">;

/** Serve one declared image, or a JSON error envelope. */
export async function handleApiSourceImage(
  res: ServerResponse,
  snapshot: SourceImageSnapshot,
  pathname: string,
  isLoopback: boolean,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (!isLoopback) {
    writeJsonError(res, 403, "loopback_required", "Content is available only on a loopback binding.");
    return;
  }
  const target = decodeTarget(pathname);
  if (target === null) {
    writeJsonError(res, 400, "invalid_source_image", "Invalid source image name.");
    return;
  }
  const body = await readDeclaredImage(snapshot, target);
  if (body === null) {
    writeJsonError(res, 404, "source_image_not_found", "Source image not found.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", sourceImageContentType(target.file));
  res.end(body);
}

/** Decode `<source>/<file>`; null unless it is two segments ending in a servable image name. */
function decodeTarget(pathname: string): SourceImageTarget | null {
  const segments = pathname.slice(SOURCE_IMAGE_ROUTE_PREFIX.length).split("/");
  if (segments.length !== 2) return null;
  try {
    const [sourceId, file] = segments.map(decodeURIComponent);
    return isSourceImageName(file) ? { sourceId, file } : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** The image's bytes, or null when the source does not declare it or the file cannot be read. */
async function readDeclaredImage(snapshot: SourceImageSnapshot, target: SourceImageTarget): Promise<Buffer | null> {
  if (!(await sourceDeclares(snapshot, target))) return null;
  const directory = path.join(snapshot.root, SOURCE_IMAGE_DIRECTORY);
  const read = await readConfinedCappedBuffer(
    snapshot.root, path.join(directory, target.file), directory, MAX_SOURCE_IMAGE_BYTES,
  );
  return read.kind === "ok" ? read.body : null;
}

/** True when `sourceId` is a readable source in the snapshot whose declared images include `file`. */
async function sourceDeclares(snapshot: SourceImageSnapshot, target: SourceImageTarget): Promise<boolean> {
  try {
    const source = await readViewerSource(snapshot.root, snapshot.sourceFilenames, target.sourceId, true);
    return Array.isArray(source.images) && source.images.includes(target.file);
  } catch (error) {
    if (error instanceof PathSafetyError) return false;
    throw error;
  }
}
