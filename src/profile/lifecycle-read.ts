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
  const real = await resolveConfinedEntityPage(root, def, slug);
  if (real === null) return undefined;
  const { meta } = parseFrontmatter(await safeReadFile(real));
  const value = meta[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve an entity page's confined real path: `<realpath(root)>/<def.directory>/<slug>.md`
 * via {@link confinedRegularFile}, or `null` when the page is absent or escapes
 * the project root (a symlinked / out-of-tree page is treated as absent — never
 * followed). The root is canonicalized FIRST so the directory base matches the
 * file's realpath (on macOS a temp/symlinked root would otherwise fail
 * confinement and spuriously report "no page"). Shared by the prev-state read and
 * the lifecycle-transition read so both confine identically.
 *
 * @param root - Absolute project root.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @returns The confined real path, or `null` when the page is absent/escaping.
 */
export async function resolveConfinedEntityPage(
  root: string,
  def: EntityTypeDef,
  slug: string,
): Promise<string | null> {
  const canonicalRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const dir = path.join(canonicalRoot, def.directory);
  return confinedRegularFile(dir, `${slug}.md`);
}
