/**
 * The wikilink targets a concept page may use, given to every concept-page
 * prompt in a compile.
 *
 * Pages are generated in parallel and written in one batch at the end, so
 * without this list a page never sees the titles of the pages written
 * alongside it and guesses link targets, which then fail to resolve. The list
 * is the same for every page in a compile (this compile's concepts first, then
 * existing pages, each sorted by title), so it adds no per-page variation.
 *
 * Each entry must resolve: a page whose slug is its slugified title is offered
 * by title, otherwise as an explicit `[[slug|Title]]` link. Titles come from
 * model extraction of untrusted sources, so they are reduced to one plain line
 * and any title that could form link syntax is dropped. The rendered list is
 * capped so a large wiki cannot crowd out the source.
 */

import type { MergedConcept } from "./types.js";
import { asCompileAccess, type CompileProject } from "./compile-access.js";
import { slugify } from "../utils/markdown.js";

/** Maximum characters of rendered link-target lines offered to one page prompt. */
export const LINK_TARGET_BUDGET_CHARS = 8_000;

/** Longest title offered as a link target; longer ones are not page names. */
const MAX_TARGET_TITLE_CHARS = 200;

/** Characters that could open, close or split a wikilink. */
const LINK_SYNTAX = /[[\]|]/;

/** A candidate target before rendering. */
export interface PageRef {
  slug: string;
  title: string;
}

/** One plain line of text: control characters and whitespace runs become single spaces. */
function plainLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Z}\s]+/gu, " ").trim();
}

/**
 * The text a page may use to link to `ref`, or null when the page cannot be
 * offered safely (link syntax in the title, an unusual slug, or no title).
 */
export function renderTarget(ref: PageRef): string | null {
  const title = plainLine(ref.title);
  if (!title || title.length > MAX_TARGET_TITLE_CHARS || LINK_SYNTAX.test(title)) return null;
  // Links resolve through slugify, so only a canonical slug (unchanged by it)
  // names the page it points at; an uppercase or odd-hyphen file name would not.
  if (!ref.slug || slugify(ref.slug) !== ref.slug) return null;
  return slugify(title) === ref.slug ? title : `[[${ref.slug}|${title}]]`;
}

/** Rendered targets sorted by title, one per slug (the first seen wins). */
function renderSorted(refs: readonly PageRef[], seenSlugs: Set<string>): string[] {
  const rendered: string[] = [];
  for (const ref of [...refs].sort((a, b) => a.title.localeCompare(b.title))) {
    const key = ref.slug.toLowerCase();
    const target = seenSlugs.has(key) ? null : renderTarget(ref);
    if (target === null) continue;
    seenSlugs.add(key);
    rendered.push(target);
  }
  return rendered;
}

/**
 * Link targets for this compile's concept pages: every concept being generated
 * now, then every existing page, within {@link LINK_TARGET_BUDGET_CHARS}.
 * @param project - The project (access seam or local root) whose concept pages supply existing targets.
 * @param merged - The concepts this compile generates pages for.
 * @returns Targets in a stable order, identical for every page in the compile.
 */
export async function buildLinkTargets(project: CompileProject, merged: readonly MergedConcept[]): Promise<string[]> {
  const seen = new Set<string>();
  const current = renderSorted(merged.map((entry) => ({ slug: entry.slug, title: entry.concept.concept })), seen);
  const existing = renderSorted(await asCompileAccess(project).listConceptTitles(), seen);
  const targets: string[] = [];
  let used = 0;
  for (const target of [...current, ...existing]) {
    // Count the rendered "- target" line; skip one that does not fit rather
    // than cutting off every shorter target after it.
    const size = target.length + 3;
    if (used + size > LINK_TARGET_BUDGET_CHARS) continue;
    targets.push(target);
    used += size;
  }
  return targets;
}
