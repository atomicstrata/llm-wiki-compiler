/**
 * Orphan management for deleted source files.
 *
 * When a source is deleted, its exclusively-owned concept pages are marked
 * orphaned (orphaned: true in frontmatter). Shared concepts are preserved
 * to avoid losing combined content from prior compilations.
 *
 * After compilation, frozen slugs (shared concepts that lost a contributor)
 * are checked against the updated state. Any that lost ALL owners are
 * orphaned as a cleanup pass.
 */

import path from "path";
import { readState, removeSourceState } from "../utils/state.js";
import {
  atomicWrite,
  safeReadFile,
  parseFrontmatter,
} from "../utils/markdown.js";
import { findSharedConcepts } from "./deps.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { isSafeFilenameComponent } from "../profile/identity.js";

/**
 * Mark wiki pages as orphaned when their source is deleted.
 * Only orphans concepts exclusively owned by the deleted source.
 * Shared concepts (contributed to by other live sources) are preserved
 * as-is to avoid losing combined content from prior compilations.
 */
export async function markOrphaned(
  root: string,
  sourceFile: string,
  state: Awaited<ReturnType<typeof readState>>,
): Promise<void> {
  const sourceEntry = state.sources[sourceFile];
  if (!sourceEntry) return;

  const sharedSlugs = findSharedConcepts(sourceFile, state);

  for (const slug of sourceEntry.concepts) {
    if (sharedSlugs.has(slug)) {
      output.status("i", output.dim(`Kept: ${slug}.md (shared with other sources)`));
      continue;
    }

    await orphanPage(root, slug, "source deleted");
  }

  await removeSourceState(root, sourceFile);
}

/**
 * Check frozen slugs against the updated state after compilation.
 * If no source still claims a frozen slug, orphan its page so it doesn't
 * linger as an untracked stale file.
 */
export async function orphanUnownedFrozenPages(
  root: string,
  frozenSlugs: Set<string>,
): Promise<void> {
  const currentState = await readState(root);
  const ownedSlugs = new Set<string>();
  for (const entry of Object.values(currentState.sources)) {
    for (const slug of entry.concepts) ownedSlugs.add(slug);
  }

  for (const slug of frozenSlugs) {
    if (ownedSlugs.has(slug)) continue;
    await orphanPage(root, slug, "no remaining sources");
  }
}

/**
 * Mark a single concept page as orphaned if it exists and isn't already marked.
 * @param root - Project root directory.
 * @param slug - Concept slug to orphan.
 * @param reason - Human-readable reason for the log message.
 */
async function orphanPage(root: string, slug: string, reason: string): Promise<void> {
  // Belt-and-suspenders: even if state validation is bypassed, a non-safe slug
  // (`../escape`, an absolute or separator-bearing string) must never path-join
  // into an out-of-tree write. State read already gates this; this is the
  // independent floor at the write site.
  if (!isSafeFilenameComponent(slug)) return;
  const pagePath = path.join(root, CONCEPTS_DIR, `${slug}.md`);
  const content = await safeReadFile(pagePath);
  if (!content) return;

  const { meta } = parseFrontmatter(content);
  if (meta.orphaned === true) return;

  const updated = content.replace("---\n", "---\norphaned: true\n");
  await atomicWrite(pagePath, updated, { confineRoot: root });
  output.status("⚠", output.warn(`Orphaned: ${slug}.md (${reason})`));
}
