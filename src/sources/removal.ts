/**
 * @file src/sources/removal.ts
 * @description The I/O half of `llmwiki rm`: resolve a user-supplied ref to a
 * validated source basename, gather what the pure planner needs, and apply the
 * resulting plan under the project lock.
 *
 * The plan / dry-run / apply split mirrors `src/workflows/adapt.ts`:
 * {@link planRemoval} is READ-ONLY and takes NO lock, so `--dry-run` can print
 * exactly what would happen without any possibility of mutating the project;
 * {@link applyRemovalLocked} performs every mutation (source, pages, state)
 * inside the caller's lock and reports back what it ACTUALLY did.
 *
 * Derived-artifact regeneration is a SEPARATE step, {@link
 * regenerateDerivedLocked}, deliberately NOT called from inside
 * `applyRemovalLocked`. The caller (`rmCommand`, `src/commands/rm.ts`) runs it
 * AFTER printing the deletion report, not before, so the transcript's first
 * lines are always what the user asked for rather than this step's own
 * progress output — `rm` has no confirmation prompt, so that transcript is the
 * user's only record. Both calls still run inside the ONE held lock; the
 * split is about print ORDER, not locking.
 *
 * ## Order is load-bearing, and the interrupted state is recoverable
 *
 * `applyRemovalLocked` deletes the SOURCE FILE FIRST, before any page. A crash
 * at that point leaves source-gone / pages-present — precisely the state
 * `compile` already knows how to reconcile, by orphaning the now-unowned pages.
 * The reverse order would leave source-present / pages-gone, where `compile`
 * sees an unchanged source hash, does nothing, and the pages are gone for good.
 * A crash WITHIN the page batch is recovered by the journal itself.
 *
 * Deleting the source first also means the FALLIBLE part runs after the file is
 * already gone — `deleteWikiPagesLocked` throws by design when a page survives
 * its unlink. So {@link planRemoval} deliberately still resolves a ref whose
 * source file is absent but whose `state.sources` entry survives: that pairing
 * IS an interrupted removal, and re-running `rm` must be able to finish it
 * rather than reporting "no such source" while the pages sit on disk. See
 * {@link planRemoval} for how that is told apart from a plain typo.
 *
 * No LLM provider is REQUIRED anywhere on this path — a missing or broken
 * embeddings backend only warns (or exits under LLMWIKI_EMBED_STRICT), never
 * blocks the delete. But one CAN be called: the refresh in
 * {@link regenerateDerivedLocked} also re-embeds any other eligible page that
 * has no stored vector yet, so a removal can issue provider calls for pages it
 * never touched. See that function's docstring for the detail.
 */

import { getSource, deleteSource, sourceFileMissing } from "./store.js";
import { assertSafeSourceId } from "./source-record.js";
import {
  computeRemovalPlan,
  partitionConcepts,
  type RemovalPlan,
  type ConceptOwnership,
} from "./removal-plan.js";
import { deleteWikiPagesLocked, type SkippedDelete } from "../wiki/delete-page.js";
import {
  readStateClassified,
  writeState,
  removeSourceFrom,
  applyFrozenSlugs,
  StateTooNewError,
} from "../utils/state.js";
import { collectAllPages } from "../linter/rules.js";
import { listCandidates } from "../compiler/candidate-read.js";
import { generateIndex } from "../compiler/indexgen.js";
import { generateMOC } from "../compiler/obsidian.js";
import { updateEmbeddingsLockedCore } from "../utils/embeddings.js";
import { handleSafeEmbeddingFailure } from "../utils/embeddings-batch.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { WikiState } from "../utils/types.js";

export type { RemovalPlan } from "./removal-plan.js";

/**
 * Normalize a user-supplied `<source>` ref to a validated bare basename,
 * WITHOUT touching the filesystem.
 *
 * `.md` is appended when absent, purely as ergonomics. A path-unsafe ref (a URL
 * contains `/`, so it fails here; so does a `..` traversal) collapses to `null`
 * — `assertSafeSourceId` throws rather than returning false, so it is caught and
 * folded into that same `null`. Refusing hostile refs BEFORE any I/O is the
 * point of doing this separately from the existence checks in
 * {@link planRemoval}: an escaping ref never reaches a path-join at all.
 *
 * @param ref - The raw `<source>` argument.
 * @returns The validated basename, or `null` when the ref could never name a
 *   source.
 */
function toSourceId(ref: string): string | null {
  const id = ref.endsWith(".md") ? ref : `${ref}.md`;
  try {
    assertSafeSourceId(id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Read `.llmwiki/state.json` for `rm`, FAILING CLOSED on a state file this
 * build cannot trust, instead of `readState`'s (`src/utils/state.ts:222`)
 * fabricate-and-recover behaviour.
 *
 * `readState` treats a corrupt or too-new file as `emptyState()` (backing the
 * original up first) so the caller can carry on — correct for `compile`,
 * which REBUILDS whatever it reads, so starting from empty just means a full
 * recompile. It is WRONG for `rm`, which cannot rebuild what it destroys: a
 * plan computed against a fabricated empty state has an empty
 * `state.sources[sourceFile].concepts`, so `deleteSlugs` comes out empty too
 * — the entire point of the command, silently defeated. Worse,
 * `applyRemovalLocked` would then delete the source file, delete NO pages,
 * and persist the fabricated empty state back to disk via `writeState` —
 * wiping the compile record for every OTHER live source in the same write.
 * The command would report success while the next `compile` reprocesses the
 * whole corpus at full LLM cost and the pages `rm` should have deleted linger
 * as untracked orphans forever.
 *
 * Used by BOTH `rm` entry points ({@link planRemoval} and
 * {@link applyRemovalLocked}) so `--dry-run` and the real apply agree, and so
 * a corrupt/too-new state produces exactly ONE refusal instead of two calls
 * to `readState` each fabricating their own state and printing their own
 * "Corrupt state.json" warning.
 *
 * @param root - Absolute project root.
 * @returns The parsed state. A `missing` file returns an empty state — that
 *   IS legitimate: the source simply has no derived pages yet, and `rm`
 *   should still be able to delete the source file itself.
 * @throws {StateTooNewError} if state.json was written by a newer llmwiki.
 * @throws {Error} if state.json is present but unparseable/malformed — `rm`
 *   cannot tell which pages came from which source, so it must refuse rather
 *   than guess.
 */
async function readStateFailClosed(root: string): Promise<WikiState> {
  const classified = await readStateClassified(root);
  if (classified.status === "too-new") {
    throw new StateTooNewError(classified.state.version as number);
  }
  if (classified.status === "corrupt") {
    throw new Error(
      "`.llmwiki/state.json` is corrupt, so llmwiki cannot tell which wiki pages this " +
        "source (or any other) came from. Nothing has been removed. Run " +
        "`llmwiki state reset --yes` to back up and clear the corrupt state file (its " +
        "`--yes` path operates on raw bytes, so it works even on a corrupt file), then " +
        "`llmwiki compile` to rebuild state, and retry.",
    );
  }
  return classified.state;
}

/**
 * READ-ONLY: resolve the ref and compute the plan. Takes NO lock and writes
 * nothing — including on a corrupt or too-new `state.json`, which
 * {@link readStateFailClosed} makes this REFUSE (throw) rather than silently
 * recovering-and-backing-up the way plain `readState` would — so `--dry-run`
 * is unconditionally incapable of mutating the project.
 *
 * Also resolves the active profile (one more lock-free, read-only lookup
 * alongside state/pages/candidates) purely to label the plan with its id —
 * see {@link RemovalPlan.profileId}. Nothing about the delete/keep split
 * depends on it. Uses the same helper `compile`'s index generation uses
 * (`loadNonDefaultProfile`, `src/compiler/indexgen.ts:61`), so a malformed
 * `profile.json` fails this command exactly as it already fails `compile` —
 * never silently ignored.
 *
 * ## Resolves an INTERRUPTED removal, not just a live source
 *
 * A ref normally names a source that is on disk. It ALSO resolves when the
 * source FILE is gone but `state.sources[<id>]` survives, which is the exact
 * signature of an `rm` that deleted the source file (the first mutation
 * {@link applyRemovalLocked} performs) and then threw before finishing its
 * pages and state — `deleteWikiPagesLocked` throws by design when a page
 * survives its unlink. Without this, the retry a user reaches for first
 * ("run it again") would report "no such source" and exit before touching
 * anything, while the pages sat on disk and the journal batch sat pending.
 *
 * Absence is checked with {@link sourceFileMissing} rather than inferred from
 * `getSource` returning `null`, because `getSource` also returns `null` for a
 * SYMLINK or a directory at that path — present, just not a valid source. Only
 * genuine absence means "a previous removal got partway"; anything else stays
 * a plain "no such source", so `rm` can never be talked into deleting pages
 * around a path it refuses to treat as a source.
 *
 * @param root - Absolute project root.
 * @param ref - The raw `<source>` argument.
 * @returns The plan, or `null` when the ref matches neither a live source nor
 *   an interrupted removal.
 * @throws {StateTooNewError} if state.json was written by a newer llmwiki.
 * @throws {Error} if state.json is corrupt — see {@link readStateFailClosed}.
 */
export async function planRemoval(root: string, ref: string): Promise<RemovalPlan | null> {
  const sourceFile = toSourceId(ref);
  if (sourceFile === null) return null;
  const [state, pages, candidates, profile, record, fileMissing] = await Promise.all([
    readStateFailClosed(root),
    collectAllPages(root),
    listCandidates(root),
    loadNonDefaultProfile(root),
    getSource(root, sourceFile),
    sourceFileMissing(root, sourceFile),
  ]);
  const sourcePresent = record !== null;
  const resumable = fileMissing && state.sources[sourceFile] !== undefined;
  if (!sourcePresent && !resumable) return null;
  const profileId = profile?.profile.profileId ?? null;
  return computeRemovalPlan({ sourceFile, state, pages, candidates, profileId, sourcePresent });
}

/**
 * What {@link applyRemovalLocked} actually did — the source of truth the CLI's
 * `printPlan` (`src/commands/rm.ts`) must report from, never the pre-lock
 * `RemovalPlan` itself, which can overstate reality.
 */
export interface RemovalApplyResult {
  /** Slugs actually unlinked. */
  deleted: string[];
  /** Slugs the delete batch itself refused at the filename-safety floor. */
  skipped: SkippedDelete[];
  /**
   * Whether a source FILE was actually unlinked. `false` on the resume path
   * (see {@link planRemoval}), where the file was already gone before this
   * removal started — the CLI must not claim to have deleted it.
   */
  sourceDeleted: boolean;
}

/**
 * Apply a plan: MUTATE ONLY. PRECONDITION: the caller already holds the
 * project lock. See the file header for why the source file is deleted
 * before the pages, and for why derived-artifact regeneration is a separate,
 * caller-sequenced step rather than something this function does itself.
 *
 * ## The plan is intent; freshly-read state is the authority
 *
 * {@link planRemoval} reads state WITHOUT the lock — deliberately, so
 * `--dry-run` never has to take it — which leaves a window between that read
 * and this one where a concurrent `compile`, `watch` or `review approve` can
 * land. `llmwiki watch` auto-recompiles on any change under `sources/`, so
 * this is the documented workflow, not an exotic schedule.
 *
 * So ownership is RECOMPUTED here from freshly-read state via
 * {@link partitionConcepts} — the same function that produced the plan — and
 * {@link assertOwnershipUnchanged} REFUSES the whole removal if the two
 * disagree. Recomputing rather than filtering the plan is load-bearing: a
 * filter can only ever ask "is a slug the plan already doomed now shared?",
 * which proves "not NEWLY shared" when the property needed is "STILL OURS".
 * Three drifts slip past a filter and are caught by comparison instead — a
 * concept TRANSFERRED to another source (the plan's stale verdict would delete
 * a page a live source now owns exclusively), a concept that became EXCLUSIVE
 * (kept, then owned by nothing), and a concept newly ADDED to this source (its
 * page left behind untracked). The extreme case is a concurrent compile
 * dropping the source's state entry outright, which empties the shared set and
 * makes a filter approve every slug in the stale plan.
 *
 * Refusing is deliberate over reconciling. Re-planning under the lock would
 * delete a set the user never saw; on a destructive command with no
 * confirmation prompt, the plan the user reasoned about is the only set worth
 * honouring, and re-running is cheap.
 *
 * ## Freezing
 *
 * MARKS the source's still-shared concepts before writing state, the same way
 * `compile`'s own deletion path marks them. A kept page's FILE survives on
 * disk, but its on-disk CONTENT is a merge that includes the now-removed
 * source's contribution — the file alone carries no memory of that. Recording
 * the slug in `state.frozenSlugs` is what says so. Without it the next
 * recompile of a remaining contributor rebuilds the page from live sources as
 * if nothing had been removed, and the removed source's contribution silently
 * vanishes with no record that it was ever there.
 *
 * A persisted slug is a RECONCILIATION marker, not a permanent hold. What
 * compile does with it belongs to compile, not to `rm`: it rebuilds the page
 * cleanly from whatever owners survive, dropping the removed source's
 * contribution, and orphans a page no live source owns any more. The marker is
 * retired only once that replacement is actually committed — if extraction or
 * page validation fails, the marker and the survivors' ownership are both
 * preserved so a later compile tries again.
 *
 * This function's contract is only that the mark is set. The set is UNIONED
 * with whatever is already persisted (never replaced via
 * {@link applyFrozenSlugs}), so an earlier removal's or compile's markers are
 * never dropped by a later one.
 *
 * @param root - Absolute project root.
 * @param plan - The plan produced by {@link planRemoval}.
 * @returns See {@link RemovalApplyResult}.
 * @throws {Error} if the source's ownership moved since `plan` was computed —
 *   BEFORE any mutation, so a refusal leaves the project untouched.
 */
export async function applyRemovalLocked(root: string, plan: RemovalPlan): Promise<RemovalApplyResult> {
  // Read state FIRST, before any mutation, while the source's own state entry
  // is still present — partitionConcepts needs it to see which concepts this
  // source currently owns. Reused below for freezing and for removeSourceFrom,
  // so the whole apply works from one consistent under-lock snapshot.
  const fresh = await readStateFailClosed(root);
  const current = partitionConcepts(plan.sourceFile, fresh);
  assertOwnershipUnchanged(plan, current);

  const sourceDeleted = await deleteSource(root, plan.sourceFile);
  // Floor-skipped pages are RETURNED, never swallowed: compile surfaces its own
  // skips as errors (src/compiler/index.ts:225), and a page the user asked to
  // remove that silently stayed on disk is exactly the failure `rm` exists to
  // prevent.
  const { skipped } = await deleteWikiPagesLocked(root, current.deleteSlugs);
  const deleted = withoutSkipped(current.deleteSlugs, skipped);

  const frozen = new Set(fresh.frozenSlugs ?? []);
  for (const slug of current.keptSlugs) frozen.add(slug);
  const next = applyFrozenSlugs(removeSourceFrom(fresh, plan.sourceFile), frozen);
  await writeState(root, next);

  return { deleted, skipped, sourceDeleted };
}

/**
 * `deletable` minus whatever the delete batch itself refused at the filename-
 * safety floor — the accurate "what actually got unlinked" list. Split out so
 * {@link applyRemovalLocked} reads as one straight-line sequence and this
 * one-purpose set-difference is independently nameable and testable.
 *
 * @param deletable - The re-verified delete candidates passed to {@link
 *   deleteWikiPagesLocked}.
 * @param skipped - That call's floor-skipped subset of `deletable`.
 * @returns `deletable` with every skipped slug removed.
 */
function withoutSkipped(deletable: string[], skipped: SkippedDelete[]): string[] {
  const skippedSlugs = new Set(skipped.map((s) => s.slug));
  return deletable.filter((slug) => !skippedSlugs.has(slug));
}

/**
 * REFUSE the removal if the source's ownership moved between the pre-lock plan
 * and the under-lock read. Called BEFORE the first mutation, so a refusal
 * leaves the source file, every page, and `state.json` exactly as they were.
 *
 * Compares BOTH halves of the split, not just the doomed one: a slug moving
 * from kept to deletable is as much a changed world as a slug moving the other
 * way, and a slug appearing in or disappearing from the source's concept list
 * shows up in one half or the other. See {@link applyRemovalLocked} for why the
 * answer to a changed world is refusal rather than re-planning.
 *
 * @param plan - The pre-lock plan, i.e. what the user was shown and what this
 *   removal was authorized to do.
 * @param current - The same split recomputed from state read under the lock.
 * @throws {Error} naming the source and telling the user to re-run.
 */
function assertOwnershipUnchanged(plan: RemovalPlan, current: ConceptOwnership): void {
  const unchanged =
    sameSlugs(plan.deleteSlugs, current.deleteSlugs) && sameSlugs(plan.keptSlugs, current.keptSlugs);
  if (unchanged) return;
  throw new Error(
    `The project changed while \`llmwiki rm\` was preparing: the pages derived from ` +
      `"${plan.sourceFile}" are no longer the ones this removal planned to act on. A ` +
      `concurrent \`compile\`, \`watch\` or \`review approve\` landed in between. Nothing has ` +
      `been removed — re-run \`llmwiki rm ${plan.sourceFile}\` to plan against the current state.`,
  );
}

/**
 * Multiset equality for two slug lists. Order-insensitive because
 * {@link partitionConcepts} preserves whatever order state happens to record,
 * and a pure reordering is not a changed world. Length-then-sorted-compare
 * rather than a `Set` round-trip so a duplicated slug on one side alone is
 * still a difference.
 */
function sameSlugs(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((slug, index) => slug === b[index]);
}

/**
 * Regenerate the artifacts derived from the page set: the index, the MOC, and
 * the embedding store. PRECONDITION: the caller MUST already hold the project
 * lock — this acquires nothing itself; the `Locked` suffix follows this
 * codebase's convention for that (e.g. {@link deleteWikiPagesLocked}), not a
 * claim that this function does any locking of its own.
 *
 * EXPORTED and called SEPARATELY from {@link applyRemovalLocked} — deliberately
 * not folded into it. `rmCommand` (`src/commands/rm.ts`) calls this AFTER
 * printing the deletion report, not before, so the transcript's first lines
 * are always the delete the user asked for, never this step's own progress
 * output (`generateIndex` prints "Generating index..." / "Index updated with
 * N pages.") and never a "Regenerated" summary asserted ahead of the work it
 * describes. Both calls run inside the SAME held lock either way.
 *
 * The embeddings refresh routes through {@link handleSafeEmbeddingFailure}, the
 * SAME shared catch every other lock-free `updateEmbeddingsLockedCore` caller
 * uses (`src/commands/query-save.ts`, `src/utils/embeddings-refresh.ts`) — so
 * `LLMWIKI_EMBED_STRICT` (the project-wide "any embedding failure exits
 * non-zero" opt-in) is honoured here exactly as everywhere else, instead of
 * this one path silently diverging from it. By default a failure only warns —
 * semantic search is an enhancement, and a missing key must not leave a
 * half-removed project — but by the time this runs, the source file, the
 * pages, and state.json have ALL already landed durably AND been reported to
 * the user, so a strict-mode rethrow here reports a stale embedding store on
 * top of a deletion the transcript already shows succeeded, never a failed
 * delete with nothing to show for it.
 *
 * The empty changed-page list only means THIS removal contributes no new text
 * of its own — it does NOT make this a prune-only step. `updateEmbeddingsLockedCore`
 * independently re-embeds every eligible page that has no stored vector yet
 * (`addNewEligiblePages`, `src/utils/embeddings-migrate.ts:243-248`) and, if the
 * store's embedding identity changed, EVERY eligible page (`rebuild`, same file
 * `:91-96`) — either can call the provider for pages this removal never
 * touched. `reembedIntoStore` also constructs the provider UNCONDITIONALLY
 * (`src/utils/embeddings-write.ts:62`), so this step is attempted even with no
 * embeddings backend configured at all; it is the `handleSafeEmbeddingFailure`
 * catch above, not a skip, that keeps a missing/broken backend from failing
 * the removal by default.
 *
 * @param root - Absolute project root.
 */
export async function regenerateDerivedLocked(root: string): Promise<void> {
  await generateIndex(root);
  await generateMOC(root);
  try {
    await updateEmbeddingsLockedCore(root, []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }
}
