/**
 * Semantic dependency tracking for cross-source concept sharing.
 *
 * When multiple source files contribute to the same concept, a change in one
 * source should trigger recompilation of that concept using content from ALL
 * contributing sources. This module builds a reverse index from concepts back
 * to their source files, then identifies which unchanged sources are affected
 * by changes to other sources that share concepts with them.
 *
 * Without this, if sources A and B both produce concept X and source A changes,
 * concept X would be regenerated using only source A's content — losing source
 * B's contribution entirely.
 */

import { slugify } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import type { WikiState, SourceChange, ExtractedConcept } from "../utils/types.js";
import type { CompileStateDraft } from "./compile-state-draft.js";

export interface ExtractionResult {
  sourceFile: string;
  sourcePath: string;
  sourceContent: string;
  concepts: ExtractedConcept[];
}

/**
 * Build a reverse map from concept slugs to the source files that produced them.
 * @param sources - The sources record from WikiState.
 * @returns Map where keys are concept slugs and values are arrays of source filenames.
 */
function buildConceptToSourcesMap(
  sources: WikiState["sources"],
): Map<string, string[]> {
  const conceptMap = new Map<string, string[]>();

  for (const [sourceFile, entry] of Object.entries(sources)) {
    for (const slug of entry.concepts) {
      const existing = conceptMap.get(slug);
      if (existing) {
        existing.push(sourceFile);
      } else {
        conceptMap.set(slug, [sourceFile]);
      }
    }
  }

  return conceptMap;
}

/** Extract filenames from changes matching a given status. */
function filesByStatus(
  changes: SourceChange[],
  ...statuses: SourceChange["status"][]
): Set<string> {
  const statusSet = new Set(statuses);
  return new Set(
    changes.filter((c) => statusSet.has(c.status)).map((c) => c.file),
  );
}

/** Flatten the old-state co-owners for every concept claimed by one source. */
function knownCoOwners(
  sourceFile: string,
  state: WikiState,
  conceptMap: Map<string, string[]>,
): string[] {
  const concepts = state.sources[sourceFile]?.concepts ?? [];
  return concepts.flatMap((slug) => conceptMap.get(slug) ?? []);
}

/**
 * Walk every live co-owner reachable from the seed sources to a fixed point.
 * @param state - Persisted source-to-concept ownership graph.
 * @param seeds - Sources whose known concepts seed graph traversal.
 * @param excluded - Changed or deleted sources that must not enter the result.
 * @param initialAffected - Live owners already known to require extraction.
 */
function expandSharedOwnerClosure(
  state: WikiState,
  seeds: Iterable<string>,
  excluded: ReadonlySet<string>,
  initialAffected: Iterable<string> = [],
): string[] {
  const conceptMap = buildConceptToSourcesMap(state.sources);
  const affected = new Set(
    [...initialAffected].filter((file) => !excluded.has(file)),
  );
  const queue = [...seeds, ...affected];
  const visited = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const sourceFile = queue[index];
    if (visited.has(sourceFile)) continue;
    visited.add(sourceFile);
    for (const contributor of knownCoOwners(sourceFile, state, conceptMap)) {
      if (excluded.has(contributor) || affected.has(contributor)) continue;
      affected.add(contributor);
      queue.push(contributor);
    }
  }
  return [...affected];
}

/**
 * Identify unchanged sources that need recompilation because they share
 * concepts with directly changed sources. This enables correct cross-source
 * concept regeneration — ensuring shared concepts are rebuilt with content
 * from ALL contributing sources.
 *
 * Deleted sources also seed affected-owner discovery. Their surviving
 * co-contributors rebuild shared pages from the remaining evidence so deleted
 * claims and citations do not stay frozen in the wiki.
 *
 * Persisted frozen slugs are legacy/retry reconciliation markers. Their live
 * owners are scheduled even when every source hash is otherwise current.
 *
 * @param state - The current persisted WikiState.
 * @param directChanges - Changes detected by hash comparison.
 * @returns Filenames of indirectly affected sources not already in the changed list.
 */
export function findAffectedSources(
  state: WikiState,
  directChanges: SourceChange[],
  allDetected: SourceChange[] = directChanges,
): string[] {
  const changedFiles = filesByStatus(directChanges, "new", "changed");
  const deletedFiles = filesByStatus(directChanges, "deleted");
  // Exclusion uses EVERY detected deletion, not only the ones this run acts on.
  // A scoped run (`refresh --stale`) narrows what to compile with a
  // `changeFilter`, but "what should this run act on" and "what no longer
  // exists" are different questions. Answering the second from the filtered
  // list makes an excluded deletion look like a live co-owner: the closure
  // schedules it and extraction reads a file that is gone. It stays in state,
  // pending for a later unscoped compile.
  const detectedDeletions = filesByStatus(allDetected, "deleted");
  const conceptMap = buildConceptToSourcesMap(state.sources);
  const excluded = new Set([...changedFiles, ...deletedFiles, ...detectedDeletions]);
  const frozenOwners = findSlugOwners(
    new Set(state.frozenSlugs ?? []),
    conceptMap,
    [excluded],
  );
  return expandSharedOwnerClosure(
    state,
    excluded,
    excluded,
    frozenOwners,
  );
}

/**
 * Find pages that require a clean rebuild or orphan reconciliation.
 * Includes legacy frozen slugs plus concepts shared by a deleted source and at
 * least one source that survives this compile.
 * @param state - Current persisted state.
 * @param changes - All detected source changes in this batch.
 * @returns Concept slugs whose old page must not be reused as prompt context.
 */
export function findReconciliationSlugs(
  state: WikiState,
  changes: SourceChange[],
): Set<string> {
  const reconciliation = new Set<string>(state.frozenSlugs ?? []);
  const deletedFiles = new Set(
    changes.filter((c) => c.status === "deleted").map((c) => c.file),
  );
  const conceptMap = buildConceptToSourcesMap(state.sources);

  for (const file of deletedFiles) {
    const entry = state.sources[file];
    if (!entry) continue;
    for (const slug of entry.concepts) {
      const owners = conceptMap.get(slug) ?? [];
      if (owners.some((owner) => !deletedFiles.has(owner))) reconciliation.add(slug);
    }
  }

  return reconciliation;
}

/**
 * Persist extraction-frozen slugs that were not successfully regenerated by
 * all their current contributors.
 * A slug is safe to unfreeze when every source that claims it in state
 * was compiled in this batch and successfully extracted it.
 * @param draft - In-memory CompileStateDraft the function reads/mutates instead of disk state,
 *   so freshly-compiled markers from this run are visible when making unfreeze decisions.
 * @param frozenSlugs - Concept slugs held because a required extraction failed.
 * @param successfulExtractions - Extraction results from sources compiled in this batch.
 */
/**
 * What a run asked reconciliation to rebuild, and what it actually committed.
 *
 * `pending` is the set computed for this run; `replaced` is the set whose page
 * reached `writtenPages`. A pending slug missing from `replaced` stays frozen
 * so a later compile tries again.
 */
export interface ReconciliationOutcome {
  pending: ReadonlySet<string>;
  replaced: ReadonlySet<string>;
}

/** Default for callers with nothing pending: nothing to retain. */
const NOTHING_PENDING: ReconciliationOutcome = { pending: new Set(), replaced: new Set() };

export function persistFrozenSlugs(
  draft: CompileStateDraft,
  frozenSlugs: Set<string>,
  successfulExtractions: ExtractionResult[],
  reconciliation: ReconciliationOutcome = NOTHING_PENDING,
): void {
  // Read the draft (reflects this run's compiled markers), not disk, so the
  // unfreeze decision sees freshly-compiled owners.
  const currentState = draft.read();
  const conceptMap = buildConceptToSourcesMap(currentState.sources);

  // Concepts successfully extracted in this batch, keyed by slug.
  const extractedBy = new Set<string>();
  for (const result of successfulExtractions) {
    if (result.concepts.length === 0) continue;
    for (const c of result.concepts) {
      extractedBy.add(slugify(c.concept));
    }
  }
  const compiledFiles = new Set(
    successfulExtractions
      .filter((r) => r.concepts.length > 0)
      .map((r) => r.sourceFile),
  );

  const remaining = new Set<string>();
  for (const slug of frozenSlugs) {
    const owners = conceptMap.get(slug) ?? [];
    // Unfreeze only if ALL current owners were compiled and extracted it.
    const allOwnersCompiled = owners.length > 0
      && owners.every((f) => compiledFiles.has(f))
      && extractedBy.has(slug);

    if (!allOwnersCompiled) remaining.add(slug);
  }

  // A reconciliation marker is retired by a COMMITTED replacement, never by a
  // successful extraction. Validation lives one frame above the renderer
  // (`validateWikiPage` in review-pipeline.ts): an invalid body returns an
  // error and no live write, so the slug never reaches `writtenPages` even
  // though every stage before it succeeded. Retiring on extraction leaves the
  // old page orphaned with nothing left to say it is stale, which is the
  // terminal state reconciliation exists to end.
  for (const slug of reconciliation.pending) {
    if (!reconciliation.replaced.has(slug)) remaining.add(slug);
  }

  draft.setFrozen(remaining);
}

/**
 * Collect concept slugs from extractions that were not in the source's
 * previous concept list — these are "newly gained" concepts that
 * findAffectedSources could not have matched pre-extraction.
 */
function collectFreshSlugs(
  extractions: ExtractionResult[],
  state: WikiState,
): Set<string> {
  const freshSlugs = new Set<string>();

  for (const result of extractions) {
    const oldConcepts = new Set(state.sources[result.sourceFile]?.concepts ?? []);
    for (const c of result.concepts) {
      const slug = slugify(c.concept);
      if (!oldConcepts.has(slug)) freshSlugs.add(slug);
    }
  }

  return freshSlugs;
}

/**
 * Find unchanged sources that own any of the given slugs, excluding files
 * present in the provided exclusion sets.
 */
function findSlugOwners(
  slugs: Set<string>,
  conceptMap: Map<string, string[]>,
  excludeSets: Set<string>[],
): string[] {
  const affected = new Set<string>();

  for (const slug of slugs) {
    const owners = conceptMap.get(slug);
    if (!owners) continue;
    for (const owner of owners) {
      const isExcluded = excludeSets.some((s) => s.has(owner));
      if (!isExcluded) affected.add(owner);
    }
  }

  return Array.from(affected);
}

/**
 * Post-extraction check for compiled sources whose freshly extracted concepts
 * overlap with unchanged sources not already in the batch. Covers two cases
 * that findAffectedSources (pre-extraction) cannot detect:
 *   1. New sources have no state entry, so their concepts are unknown.
 *   2. Changed sources may gain concepts they didn't previously have.
 * @param extractions - Results from Phase 1 extraction.
 * @param state - Current persisted state.
 * @param allChanges - Full changes array including deleted/unchanged entries.
 * @param alreadyExtracted - Sources completed by earlier fixed-point rounds.
 * @returns Filenames of unchanged sources that share concepts with compiled sources.
 */
export function findLateAffectedSources(
  extractions: ExtractionResult[],
  state: WikiState,
  allChanges: SourceChange[],
  alreadyExtracted: ReadonlySet<string> = new Set(),
): string[] {
  const compilingFiles = filesByStatus(allChanges, "new", "changed");
  for (const file of alreadyExtracted) compilingFiles.add(file);
  const deletedFiles = filesByStatus(allChanges, "deleted");
  const conceptMap = buildConceptToSourcesMap(state.sources);
  const freshSlugs = collectFreshSlugs(extractions, state);
  const excluded = new Set([...compilingFiles, ...deletedFiles]);
  const discovered = findSlugOwners(freshSlugs, conceptMap, [excluded]);
  return expandSharedOwnerClosure(state, discovered, excluded, discovered);
}

/**
 * Find concept slugs from a source that are also produced by other sources.
 * Used by markOrphaned to skip orphaning shared concepts when a source is
 * deleted — preserving combined content from prior compilations.
 * @param sourceFile - The source being checked.
 * @param state - Current persisted state.
 * @returns Set of slugs that have at least one other contributing source.
 */
export function findSharedConcepts(
  sourceFile: string,
  state: WikiState,
): Set<string> {
  const shared = new Set<string>();
  const sourceEntry = state.sources[sourceFile];
  if (!sourceEntry) return shared;

  const conceptMap = buildConceptToSourcesMap(state.sources);

  for (const slug of sourceEntry.concepts) {
    const contributors = conceptMap.get(slug);
    if (contributors && contributors.length > 1) {
      shared.add(slug);
    }
  }

  return shared;
}

/**
 * Freeze concepts from failed extractions and persist their state with a
 * blank hash so they retry on the next compile. Preserves old concept lists
 * to keep dependency tracking intact.
 * @param draft - In-memory CompileStateDraft the function reads/mutates instead of disk state,
 *   buffering source entries with a blank hash so they are retried on the next compile.
 * @param results - Extraction results from this batch; entries with no concepts are failed.
 * @param frozenSlugs - Mutable set of frozen slugs; old concept slugs from failed sources
 *   are added here to prevent them from being orphaned prematurely.
 */
export function freezeFailedExtractions(
  draft: CompileStateDraft,
  results: ExtractionResult[],
  frozenSlugs: Set<string>,
): void {
  for (const result of results) {
    if (result.concepts.length > 0) continue;

    output.status("!", output.warn(`${result.sourceFile}: no concepts — will retry.`));
    const oldConcepts = draft.read().sources[result.sourceFile]?.concepts ?? [];
    for (const slug of oldConcepts) frozenSlugs.add(slug);

    draft.setSource(result.sourceFile, {
      hash: "",
      concepts: oldConcepts,
      compiledAt: new Date().toISOString(),
    });
  }
}
