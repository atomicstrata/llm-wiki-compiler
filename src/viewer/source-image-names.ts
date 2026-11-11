/**
 * Which image files a source may show.
 *
 * A source keeps its original images in `sources/images/` and names them in a
 * frontmatter `images:` list. This module owns the rule for a servable image
 * name and reads a source's declared list, so the metadata route and the image
 * route agree on both.
 */

import path from "path";
import { parseFrontmatter } from "../utils/markdown.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";

/** Served extensions and their content types; doubles as the allowlist. SVG is absent: it can carry script. */
const SOURCE_IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Content type for a servable image name. */
export function sourceImageContentType(name: string): string {
  return SOURCE_IMAGE_CONTENT_TYPES[path.extname(name).toLowerCase()];
}

/** True when `name` ends in a served extension. */
function hasServedExtension(name: string): boolean {
  return Object.hasOwn(SOURCE_IMAGE_CONTENT_TYPES, path.extname(name).toLowerCase());
}

/** True when `name` is one path segment, with no separator or traversal. */
function isSingleSegment(name: string): boolean {
  try {
    assertSafeSlug(name);
    return true;
  } catch (error) {
    if (error instanceof PathSafetyError) return false;
    throw error;
  }
}

/** True for a servable image name: one safe segment with a served extension. */
export function isSourceImageName(value: unknown): value is string {
  return typeof value === "string" && hasServedExtension(value) && isSingleSegment(value);
}

/** The images a source declares in frontmatter `images:`, limited to servable names. */
export function declaredSourceImages(sourceContent: string): string[] {
  const declared = parseFrontmatter(sourceContent).meta.images;
  return Array.isArray(declared) ? declared.filter(isSourceImageName) : [];
}
