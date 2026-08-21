/**
 * @file src/sources/removal-plan.ts
 * @description The PURE plan behind `llmwiki rm` — no I/O whatsoever.
 *
 * Given the persisted state, every wiki page's content, and the pending review
 * candidates, this partitions a source's derived concepts into the ones it owns
 * EXCLUSIVELY (safe to delete) and the ones a live source still contributes to
 * (kept), then reports the two consequences a deletion has elsewhere in the
 * project: surviving pages whose wikilinks would break, and pending candidates
 * that reference the removed source.
 *
 * The exclusive/shared split lives in {@link partitionConcepts}, which delegates
 * to {@link findSharedConcepts} — the SAME function compile's `markOrphaned`
 * uses — so `rm` and `compile` cannot drift on the one rule protecting
 * multi-source pages from deletion. Reimplementing that rule here would be the
 * single most damaging duplication in this feature.
 *
 * `partitionConcepts` is exported rather than inlined because the split is
 * needed TWICE per removal, against two different reads of state: once here for
 * the pre-lock plan, and once by `applyRemovalLocked` against freshly-read
 * state under the lock. Those two must be computed the same way to be
 * comparable at all.
 *
 * Also carries the active profile id straight from input to output (see
 * {@link RemovalPlanInput.profileId}) untouched — this module stays pure and
 * never loads the profile itself, but the plan is where the CLI's
 * profile-limitation warning gets its signal.
 *
 * Purity is the point: the partition and the link scan are unit-testable with
 * plain objects, with no project on disk and no temp directories.
 */

import path from "path";
import { findSharedConcepts } from "../compiler/deps.js";
import { findMatchesInContent } from "../linter/rules-shared.js";
import { slugify } from "../utils/markdown.js";
import type { WikiState, ReviewCandidate } from "../utils/types.js";

/**
 * Matches `[[Target]]` and `[[Target|Display]]`, capturing the inner text.
 *
 * Declared locally, matching the existing convention: `src/linter/rules.ts` and
 * `src/schema/helpers.ts` each own an identical private copy rather than sharing
 * one. Keeping the third copy local follows that precedent and avoids widening
 * this change into a refactor of the linter's module boundaries.
 */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/** A surviving page holding a wikilink to a page this removal would delete. */
export interface BrokenLinkRef {
  /** Path of the surviving page, exactly as `collectAllPages` reports it. */
  file: string;
  /** The doomed slug the link points at. */
  target: string;
}

/**
 * A source's concepts split by whether it owns them alone.
 *
 * Returned by {@link partitionConcepts} and used in TWO places that must never
 * disagree: the pre-lock plan, and `applyRemovalLocked`'s under-lock re-check
 * (`src/sources/removal.ts`). Sharing one shape and one function is the point
 * — the two computing the split differently is precisely how a stale plan
 * survived its own re-verification.
 */
export interface ConceptOwnership {
  /** Slugs this source owns exclusively — safe to delete. */
  deleteSlugs: string[];
  /** Slugs a live source still contributes to — preserved. */
  keptSlugs: string[];
}

/**
 * Split `sourceFile`'s recorded concepts into the ones it owns exclusively and
 * the ones a live source still contributes to.
 *
 * The shared half delegates to {@link findSharedConcepts} — the SAME function
 * compile's `markOrphaned` uses — so `rm` and `compile` cannot drift on the one
 * rule protecting multi-source pages from deletion.
 *
 * Total: a source with no state entry (never compiled) yields two empty lists
 * rather than throwing, because deleting such a source is legitimate — there is
 * simply nothing derived to clean up.
 *
 * @param sourceFile - Bare basename of the source, e.g. `"untitled.md"`.
 * @param state - The state to read ownership from. Which state that is matters:
 *   the pre-lock read for a plan, the under-lock read for the authority.
 * @returns The exclusive/shared split. Both lists preserve `state`'s own
 *   concept order.
 */
export function partitionConcepts(sourceFile: string, state: WikiState): ConceptOwnership {
  const concepts = state.sources[sourceFile]?.concepts ?? [];
  const shared = findSharedConcepts(sourceFile, state);
  return {
    deleteSlugs: concepts.filter((slug) => !shared.has(slug)),
    keptSlugs: concepts.filter((slug) => shared.has(slug)),
  };
}

/** Everything the planner needs, already read from disk by the caller. */
export interface RemovalPlanInput {
  /** Bare basename of the source being removed, e.g. `"untitled.md"`. */
  sourceFile: string;
  /** Current persisted state. */
  state: WikiState;
  /** Every wiki page, as returned by `collectAllPages`. */
  pages: Array<{ filePath: string; content: string }>;
  /** Pending review candidates, for the reference check. */
  candidates: ReviewCandidate[];
  /**
   * The active profile's id (`loadNonDefaultProfile(root)?.profile.profileId`),
   * or `null` for the built-in default project. PASSED THROUGH untouched — this
   * planner stays pure and never loads the profile itself; the caller
   * (`planRemoval` in `removal.ts`) resolves it.
   *
   * Its sole purpose is the CLI's profile-limitation warning: typed entity
   * pages approved from a Configurable Lifecycle Profile candidate record NO
   * source ownership anywhere (`review-approve.ts`'s typed/default split), so
   * `concepts`-derived `deleteSlugs`/`keptSlugs` can never be the full picture
   * of what this source contributed on a profile project. A non-null value
   * here is the only signal of that gap.
   */
  profileId: string | null;
  /**
   * Whether `sources/<sourceFile>` is actually on disk right now.
   *
   * Normally `true`. It is `false` on the RESUME path: a previous `rm` deleted
   * the source file and then threw before finishing its pages and state, so
   * the file is gone while `state.sources[sourceFile]` survives. Resolved by
   * the caller (`planRemoval` in `removal.ts`) — this planner does no I/O.
   *
   * Carried through to {@link RemovalPlan.sourcePresent} for one reason: the
   * CLI must not print "Would delete: sources/x.md" for a file that is already
   * gone.
   */
  sourcePresent: boolean;
}

/** What a removal would delete, keep, and break. */
export interface RemovalPlan {
  sourceFile: string;
  /** Exclusively-owned slugs — these get hard-deleted. */
  deleteSlugs: string[];
  /** Slugs a live source still owns — preserved untouched. */
  keptSlugs: string[];
  /** Wikilinks in surviving pages that this removal would break. */
  brokenLinks: BrokenLinkRef[];
  /** Ids of pending candidates referencing `sourceFile`. */
  candidateRefs: string[];
  /**
   * Carried straight from {@link RemovalPlanInput.profileId}. Non-null tells
   * the CLI this is a profile project, so it must warn that any typed entity
   * pages this source contributed to are untracked and were NOT considered
   * for deletion — see `printConsequences` in `src/commands/rm.ts`.
   */
  profileId: string | null;
  /**
   * Carried straight from {@link RemovalPlanInput.sourcePresent}. `false` means
   * this removal is RESUMING one that already deleted the source file, so the
   * CLI reports that file as already gone rather than claiming to delete it.
   */
  sourcePresent: boolean;
}

/**
 * Compute the full removal plan. Total: a source with no state entry (never
 * compiled) yields an empty plan rather than throwing, because deleting such a
 * source is legitimate — there is simply nothing derived to clean up.
 *
 * The delete/keep split is {@link partitionConcepts}, NOT an expression local
 * to this function, so `applyRemovalLocked`'s under-lock re-check can compute
 * the identical split from fresh state and compare the two directly.
 *
 * @param input - State, pages and candidates already read by the caller.
 * @returns The plan; safe to print without applying (`--dry-run`).
 */
export function computeRemovalPlan(input: RemovalPlanInput): RemovalPlan {
  const { sourceFile, state, pages, candidates, profileId, sourcePresent } = input;
  const { deleteSlugs, keptSlugs } = partitionConcepts(sourceFile, state);

  return {
    sourceFile,
    deleteSlugs,
    keptSlugs,
    brokenLinks: findBrokenLinks(pages, deleteSlugs),
    candidateRefs: candidates.filter((c) => c.sources.includes(sourceFile)).map((c) => c.id),
    profileId,
    sourcePresent,
  };
}

/**
 * Wikilinks in SURVIVING pages that point at a doomed slug.
 *
 * Pages being deleted are excluded first — a doomed page linking to another
 * doomed page is not a problem anyone needs to hear about. Targets are slugified
 * with the same {@link slugify} the linter's `broken-wikilink` rule uses, so this
 * warning and `llmwiki lint` agree on what counts as a match.
 */
function findBrokenLinks(
  pages: Array<{ filePath: string; content: string }>,
  deleteSlugs: string[],
): BrokenLinkRef[] {
  const doomed = new Set(deleteSlugs);
  const refs: BrokenLinkRef[] = [];
  for (const page of pages) {
    if (doomed.has(path.basename(page.filePath, ".md"))) continue;
    for (const { captured } of findMatchesInContent(page.content, WIKILINK_PATTERN)) {
      const target = slugify(captured.split("|")[0].trim());
      if (doomed.has(target)) refs.push({ file: page.filePath, target });
    }
  }
  return refs;
}
