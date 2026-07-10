/**
 * @file src/profile/lifecycle-read.ts
 * @description Path-confined readers for a typed entity page: the PREVIOUS
 * lifecycle-field value the runtime transition validator
 * ({@link validateLifecycleTransition}) checks a write against, the confined page
 * path resolver the live-apply paths share, and the handle-bound frontmatter
 * reader the relation-precondition endpoint resolver uses as evidence input.
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
import { readConfinedPageOutcome } from "../utils/confined-read.js";
import { parseFrontmatter, parseFrontmatterStatus, safeReadFile } from "../utils/markdown.js";
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
  const dir = await confinedEntityDir(root, def);
  return confinedRegularFile(dir, `${slug}.md`);
}

/** The canonical confined directory of an entity type: `<realpath(root)>/<def.directory>`. */
async function confinedEntityDir(root: string, def: EntityTypeDef): Promise<string> {
  const canonicalRoot = (await safeRealpath(root)) ?? path.resolve(root);
  return path.join(canonicalRoot, def.directory);
}

/**
 * The discriminated outcome of {@link readConfinedEntityFrontmatter}: parsed
 * `frontmatter`, a clean `absent` (page not there / escaping / symlinked / open-
 * raced / MALFORMED YAML — none of which are trusted evidence), or `unreadable`
 * (a raw I/O fault — "cannot verify" rather than "does not qualify"). The split
 * lets the endpoint resolver PARK a healthy run on a transient read fault instead
 * of miscounting it as an unmet precondition.
 */
export type EntityFrontmatterRead =
  | { kind: "frontmatter"; meta: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "unreadable"; cause: NodeJS.ErrnoException };

/**
 * Read + parse the FRONTMATTER of a confined entity page as a discriminated
 * {@link EntityFrontmatterRead}. The path resolves via {@link confinedRegularFile}
 * and the bytes come from the handle-bound, no-follow {@link readConfinedPageOutcome}
 * (the shared hardened single-page read), so a symlinked or open-raced page fails
 * CLOSED to `absent` rather than leaking an out-of-tree read, while a genuine I/O
 * fault surfaces as `unreadable`. MALFORMED frontmatter is `absent` (fail closed:
 * a page whose YAML cannot be parsed must not qualify as evidence via a coerced-
 * empty `{}` meta). LOCK-FREE — a bare confined read, safe inside a caller's
 * already-held project lock.
 *
 * @param root - Absolute project root.
 * @param def - The resolved entity type definition (supplies the directory).
 * @param slug - The page slug (the filename stem).
 * @returns The discriminated read outcome.
 */
export async function readConfinedEntityFrontmatter(
  root: string,
  def: EntityTypeDef,
  slug: string,
): Promise<EntityFrontmatterRead> {
  const dir = await confinedEntityDir(root, def);
  const real = await confinedRegularFile(dir, `${slug}.md`);
  if (real === null) return { kind: "absent" };
  const read = await readConfinedPageOutcome(real, dir);
  if (read.kind === "unreadable") return { kind: "unreadable", cause: read.cause };
  if (read.kind === "absent") return { kind: "absent" };
  const parsed = parseFrontmatterStatus(read.body);
  return parsed.malformedFrontmatter ? { kind: "absent" } : { kind: "frontmatter", meta: parsed.meta };
}
