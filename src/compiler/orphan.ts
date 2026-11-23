/**
 * Orphan management for deleted source files.
 *
 * When a source is deleted, its exclusively-owned concept pages are marked
 * orphaned (orphaned: true in frontmatter). Shared concepts are deferred so
 * the compiler can rebuild them from their surviving owners in the same run.
 *
 * After compilation, reconciliation candidates and extraction-frozen slugs
 * are checked against the updated state. Any that lost ALL owners are orphaned
 * as a cleanup pass.
 *
 * ONE BODY PER PASS, THREE DOMAIN COLLABORATORS. {@link markOrphanedWith} and
 * {@link orphanUnownedFrozenPagesWith} are the bodies. They are handed
 * {@link OrphanPassSteps}: the confined page read, the dropped-read warning
 * (with its own presence decision) and the compile page write, each the whole
 * semantics of its existing owner and NOT a storage port. The root forms keep
 * their signatures and pass {@link localOrphanPassSteps}, which call
 * `readConfinedWikiPage`, `warnDroppedWikiReadIfPresent` and
 * `applyCompilePageWritesLocked` at call time with exactly the arguments they
 * always got, so their module spies still see every call. Every decision —
 * shared, unsafe, dropped, already orphaned, the rewrite, the status lines and
 * when the draft forgets the source — stays here. Status lines still go to the
 * incumbent `output.status`.
 */

import path from "path";
import { parseFrontmatter } from "../utils/markdown.js";
import {
  readConfinedWikiPage,
  warnDroppedWikiReadIfPresent,
  type ConfinedReadResult,
} from "./confined-wiki-read.js";
import { findSharedConcepts } from "./deps.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { applyCompilePageWritesLocked, type CompilePageWrite } from "./compile-write.js";
import type { CompileStateDraft } from "./compile-state-draft.js";

/** The draft members an orphan pass uses: the in-memory state and forgetting a source. */
export type OrphanDraft = Pick<CompileStateDraft, "read" | "removeSource">;

/** The three DOMAIN steps an orphan pass composes; none is storage. */
export interface OrphanPassSteps {
  /** Read one page confined to `relDir`. Local: `readConfinedWikiPage(root, relDir, slug)`. */
  readPage(root: string, relDir: string, slug: string): Promise<ConfinedReadResult>;
  /** Warn about a dropped page only if something is at `absPath`. Local: `warnDroppedWikiReadIfPresent(absPath, relPath, reason)`. */
  warnDropped(absPath: string, relPath: string, reason: string): Promise<void>;
  /** Apply one orphan batch (possibly empty). Local: `applyCompilePageWritesLocked(root, writes)`. */
  writePages(root: string, writes: CompilePageWrite[]): Promise<unknown>;
}

/** LOCAL. The incumbent read, warning and compile page write, called at call time with their usual arguments; frozen. */
export const localOrphanPassSteps: OrphanPassSteps = Object.freeze({
  readPage: (root: string, relDir: string, slug: string) => readConfinedWikiPage(root, relDir, slug),
  warnDropped: (absPath: string, relPath: string, reason: string) => warnDroppedWikiReadIfPresent(absPath, relPath, reason),
  writePages: (root: string, writes: CompilePageWrite[]) => applyCompilePageWritesLocked(root, writes),
});

/**
 * Mark wiki pages as orphaned when their source is deleted.
 * Only orphans concepts exclusively owned by the deleted source.
 * Shared concepts (contributed to by other live sources) are deferred to the
 * deletion-reconciliation generation pass.
 * @param root - Project root directory (needed for the confined file write; stays first).
 * @param sourceFile - Source file path being deleted.
 * @param draft - In-memory CompileStateDraft the function reads/mutates instead of disk state.
 *   root stays first (needed for the confined file write); draft follows.
 */
export async function markOrphaned(
  root: string,
  sourceFile: string,
  draft: CompileStateDraft,
): Promise<void> {
  return markOrphanedWith(localOrphanPassSteps, root, sourceFile, draft);
}

/** THE ONE BODY of {@link markOrphaned}: the draft forgets the source only AFTER its batch was applied. */
export async function markOrphanedWith(
  steps: OrphanPassSteps,
  root: string,
  sourceFile: string,
  draft: OrphanDraft,
): Promise<void> {
  const state = draft.read();
  const sourceEntry = state.sources[sourceFile];
  if (!sourceEntry) return;

  const sharedSlugs = findSharedConcepts(sourceFile, state);

  // Compute the orphan write for each exclusively-owned slug (skipping shared
  // ones), then apply the non-null results as ONE journalled deletion-orphan
  // batch under compile's held lock — mirroring the generation reroute.
  const writes: CompilePageWrite[] = [];
  for (const slug of sourceEntry.concepts) {
    if (sharedSlugs.has(slug)) {
      output.status("i", output.dim(`Kept: ${slug}.md (shared with other sources)`));
      continue;
    }
    const write = await orphanPage(steps, root, slug, "source deleted");
    if (write) writes.push(write);
  }
  await steps.writePages(root, writes);

  draft.removeSource(sourceFile);
}

/**
 * Check frozen slugs against the updated state after compilation.
 * If no source still claims a reconciliation candidate, orphan its page so it
 * doesn't linger as an untracked stale file.
 * @param root - Project root directory (needed for the confined file write; stays first).
 *   root stays first (needed for the confined file write); draft follows.
 * @param draft - In-memory CompileStateDraft the function reads to check current ownership
 *   instead of disk state, so un-flushed markers from this run are visible.
 * @param frozenSlugs - Reconciliation candidates and extraction-frozen slugs.
 */
export async function orphanUnownedFrozenPages(
  root: string,
  draft: CompileStateDraft,
  frozenSlugs: Set<string>,
): Promise<void> {
  return orphanUnownedFrozenPagesWith(localOrphanPassSteps, root, draft, frozenSlugs);
}

/** THE ONE BODY of {@link orphanUnownedFrozenPages}. */
export async function orphanUnownedFrozenPagesWith(
  steps: OrphanPassSteps,
  root: string,
  draft: Pick<OrphanDraft, "read">,
  frozenSlugs: Set<string>,
): Promise<void> {
  // Read-after-write: reflects the compiled markers set earlier this run via
  // the same draft, so a slug re-claimed by a just-compiled source is NOT
  // orphaned. Reading disk here would miss those un-flushed markers.
  const currentState = draft.read();
  const ownedSlugs = new Set<string>();
  for (const entry of Object.values(currentState.sources)) {
    for (const slug of entry.concepts) ownedSlugs.add(slug);
  }

  // Apply the unowned frozen slugs as ONE journalled frozen-orphan batch.
  const writes: CompilePageWrite[] = [];
  for (const slug of frozenSlugs) {
    if (ownedSlugs.has(slug)) continue;
    const write = await orphanPage(steps, root, slug, "no remaining sources");
    if (write) writes.push(write);
  }
  await steps.writePages(root, writes);
}

/**
 * COMPUTE the orphan write for a single concept page, or return `null` to SKIP
 * it (no batch entry). The caller collects the non-null results and applies them
 * through {@link applyCompilePageWritesLocked}, so the write now flows through the
 * unified executor instead of an inline `atomicWrite`.
 *
 * The three SKIP guards are preserved — each returns `null` (never a partial
 * write, never a batch entry):
 *  1. UNSAFE slug (`!isSafeFilenameComponent`) — an out-of-tree slug must never
 *     path-join into a write; the independent floor at this site.
 *  2. ABSENT/DROPPED page (`!("content" in read)`) — a symlinked escape is NOT
 *     read and NOT re-emitted; an absent page is a silent no-op.
 *  3. ALREADY orphaned (`meta.orphaned === true`) — idempotent re-orphan no-op.
 *
 * @param steps - The page read and the dropped-read warning (the write is not asked here).
 * @param root - Project root directory.
 * @param slug - Concept slug to orphan.
 * @param reason - Human-readable reason for the log message.
 * @returns The page write to apply, or `null` when any guard skips it.
 */
export async function orphanPage(
  steps: Pick<OrphanPassSteps, "readPage" | "warnDropped">,
  root: string,
  slug: string,
  reason: string,
): Promise<CompilePageWrite | null> {
  if (!isSafeFilenameComponent(slug)) return null;
  const pagePath = path.join(root, CONCEPTS_DIR, `${slug}.md`);
  const read = await steps.readPage(root, CONCEPTS_DIR, slug);
  if (!("content" in read)) {
    await steps.warnDropped(
      pagePath,
      path.join(CONCEPTS_DIR, `${slug}.md`),
      read.dropped,
    );
    return null;
  }
  const content = read.content;

  const { meta } = parseFrontmatter(content);
  if (meta.orphaned === true) return null;

  const updated = content.replace("---\n", "---\norphaned: true\n");
  output.status("⚠", output.warn(`Orphaned: ${slug}.md (${reason})`));
  return { namespace: "concepts", slug, body: updated };
}
