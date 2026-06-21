/**
 * @file src/profile/lifecycle-read.ts
 * @description Path-confined reader for an entity page's PREVIOUS lifecycle-field
 * value — the `prev` state the runtime transition validator
 * ({@link validateLifecycleTransition}) checks a write against.
 *
 * A lifecycle transition is "from the value already on disk to the value in the
 * incoming body". This module supplies that prior value: it resolves the existing
 * `wiki/<entityType>/<slug>.md` through the SAME confined-regular-file primitive
 * the source/wiki readers use ({@link confinedRegularFile}), so a symlinked or
 * escaping page is treated as absent rather than followed. When the page does not
 * yet exist (a create) it returns `undefined`, which the validator treats as "not
 * a transition".
 */

import path from "path";
import { confinedRegularFile, safeRealpath } from "../utils/path-confine.js";
import { parseFrontmatter, safeReadFile } from "../utils/markdown.js";
import type { EntityTypeDef } from "./types.js";

/**
 * Read the previous lifecycle-field value of an entity page from disk, or
 * `undefined` when the page does not exist (a create) or carries no value for the
 * lifecycle field. The page is resolved under `<root>/<def.directory>` via
 * {@link confinedRegularFile}, so a symlinked / out-of-tree page is treated as
 * absent (returns `undefined`) — never followed.
 *
 * @param root - Absolute project root.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @param field - The lifecycle field name whose prior value is read.
 * @returns The prior lifecycle-field value as a string, or `undefined`.
 */
export async function readPrevLifecycleState(
  root: string,
  def: EntityTypeDef,
  slug: string,
  field: string,
): Promise<string | undefined> {
  // Canonicalize the root first so the directory base matches the file's
  // realpath (on macOS the temp/symlinked root would otherwise fail confinement
  // and spuriously report "no prev page").
  const canonicalRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const dir = path.join(canonicalRoot, def.directory);
  const real = await confinedRegularFile(dir, `${slug}.md`);
  if (real === null) return undefined;
  const { meta } = parseFrontmatter(await safeReadFile(real));
  const value = meta[field];
  return typeof value === "string" ? value : undefined;
}
