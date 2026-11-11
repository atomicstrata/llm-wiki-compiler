/**
 * @file src/wiki/wikilink-target.ts
 * @description The one authority on what a wikilink TARGET names, shared by
 * every reader of links: the viewer's resolver and renderer, the wikilink
 * extractors behind export and the page list, answer reporting, lint, the `rm`
 * plan and compile-side link repair.
 *
 * A bare target (`[[Argo CD]]`) is slugified and resolved by the bare-slug
 * precedence rule (concepts, then queries, then their aliases). A
 * folder-qualified target (`[[person/karl-marrett|Karl]]`,
 * `[[timeline/2026-11-05#Morning]]`) names one page by its exact directory and
 * slug, so it can reach pages a bare slug never could: the generated timeline
 * and a profile's typed entity pages. The heading after `#` is dropped.
 *
 * Kept apart from `wikilinks.ts` because the tokenizer needs it, and the
 * tokenizer is itself what `wikilinks.ts` reads links through.
 */

import { slugify } from "../utils/markdown.js";

/** A folder-qualified link target: the page's directory and its exact slug. */
export interface QualifiedWikilinkTarget {
  directory: string;
  slug: string;
}

/**
 * A qualified link's directory: lowercase slug-safe, the shape of `concepts`,
 * `queries`, `timeline` and every profile entity type id. Requiring it keeps a
 * slash in a title (`[[TCP/IP]]`) a bare link, as it always was.
 */
const QUALIFIED_DIRECTORY = /^[a-z0-9][a-z0-9-]*$/;
/**
 * A qualified link's slug: letters, digits and hyphens. Case is kept, because a
 * week page is `2026-W45`. No dot or separator can appear, so a target never
 * names a path outside its directory.
 */
const QUALIFIED_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

/**
 * The directory and slug a target names when it is folder-qualified
 * (`dir/slug`, with any `#heading` dropped), or null for a bare target. The
 * slug is matched exactly, never slugified.
 */
export function parseQualifiedTarget(target: string): QualifiedWikilinkTarget | null {
  const parts = target.split("#")[0].split("/").map((part) => part.trim());
  if (parts.length !== 2) return null;
  const [directory, slug] = parts;
  return QUALIFIED_DIRECTORY.test(directory) && QUALIFIED_SLUG.test(slug) ? { directory, slug } : null;
}

/**
 * The key a link target resolves by: `dir/slug` for a qualified target, else the
 * slugified bare target. `slugify` never writes a `/`, so a key holds one
 * exactly when it is qualified (see {@link isQualifiedKey}).
 */
export function wikilinkKey(target: string): string {
  const qualified = parseQualifiedTarget(target);
  return qualified ? `${qualified.directory}/${qualified.slug}` : slugify(target.trim());
}

/** Whether a {@link wikilinkKey} names a page by directory and slug. */
export function isQualifiedKey(key: string): boolean {
  return key.includes("/");
}
