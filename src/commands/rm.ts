/**
 * @file src/commands/rm.ts
 * @description Commander action for `llmwiki rm <source>` — delete a source and
 * the concept pages derived exclusively from it.
 *
 * Two modes, matching the surface agreed on issue #60: a bare `rm` applies, and
 * `--dry-run` prints exactly what would be deleted and kept while taking no lock
 * and touching nothing. There is deliberately NO confirmation flag, which makes
 * two other things load-bearing rather than conveniences: `--dry-run` is the only
 * pre-flight check available, and the journalled page delete is the only recovery
 * path if the process dies mid-removal.
 *
 * Returns an exit code rather than calling `process.exit`, so the behaviour is
 * assertable without spawning a process (mirrors `statusCommand`).
 *
 * NO LLM PROVIDER is required: the CLI action must not call `requireProvider()`.
 *
 * On a project using a Configurable Lifecycle Profile, `rm` still only ever
 * deletes from `state.sources[file].concepts` — typed entity pages record no
 * source ownership, so there's nothing for it to find or delete there. It does
 * NOT refuse on a profile project (a profile project can legitimately have
 * concept pages too); `printConsequences` instead warns unconditionally that
 * any typed entity pages this source contributed to were left untouched.
 *
 * TRANSCRIPT ORDER IS LOAD-BEARING, for the same "no confirmation prompt"
 * reason: the deletion report (`printPlan`) is printed BEFORE derived-artifact
 * regeneration runs (`regenerateDerivedLocked`), not after, so the first thing
 * a user sees is what they asked for, not `generateIndex`'s own "Generating
 * index..." progress chatter. Both still run inside the ONE lock acquired
 * below — this is a print-order choice, not a locking one.
 *
 * Two things that transcript must NOT overstate, both handled by
 * `printDeleted`/`printSourceLine`: a source file that was already gone before
 * this run (an interrupted removal being resumed) is never reported as
 * "Deleted", and every page line comes from what `applyRemovalLocked` actually
 * unlinked rather than from what the pre-lock plan proposed.
 */

import {
  planRemoval,
  applyRemovalLocked,
  regenerateDerivedLocked,
  type RemovalPlan,
  type RemovalApplyResult,
} from "../sources/removal.js";
import type { SkippedDelete } from "../wiki/delete-page.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import * as output from "../utils/output.js";

/** Options for {@link rmCommand}. */
export interface RmOptions {
  /** Print the plan and exit without taking the lock or changing anything. */
  dryRun?: boolean;
}

/**
 * Run the removal.
 *
 * @param ref - The `<source>` argument: a basename, with or without `.md`.
 * @param options - Command flags.
 * @returns The process exit code (0 success, 1 refusal).
 */
export async function rmCommand(ref: string, options: RmOptions = {}): Promise<number> {
  const root = process.cwd();
  const plan = await planRemoval(root, ref);
  if (plan === null) {
    output.status("x", output.error(`No source matches "${ref}". Look in sources/ for the filename.`));
    return 1;
  }

  if (options.dryRun) {
    printPlan(plan, true);
    return 0;
  }

  // Non-blocking: a compile holding the lock means refuse cleanly, never force.
  if (!(await acquireLock(root))) {
    output.status("x", output.error("Another llmwiki process holds the project lock. Try again when it finishes."));
    return 1;
  }
  let applied: RemovalApplyResult;
  try {
    // Report BEFORE housekeeping: printPlan documents what applyRemovalLocked
    // actually did before regenerateDerivedLocked's own progress output (or a
    // LLMWIKI_EMBED_STRICT throw) can appear in the transcript. Both calls stay
    // inside this one held lock.
    applied = await applyRemovalLocked(root, plan);
    printPlan(plan, false, applied);
    await regenerateDerivedLocked(root);
    printRegenerated(applied.deleted.length);
  } finally {
    await releaseLock(root);
  }
  return reportSkipped(applied.skipped);
}

/**
 * Warn about each page the delete batch could not remove, and derive the exit
 * code from whether any were skipped. Split out of {@link rmCommand} to keep
 * its cyclomatic complexity down — a page that failed the filename floor is
 * still on disk, and saying so is the difference between "removed" and
 * "mostly removed"; never swallow it.
 *
 * @param skipped - Slugs the delete batch refused, with their skip reason.
 * @returns 1 if anything was skipped, 0 otherwise.
 */
function reportSkipped(skipped: SkippedDelete[]): number {
  for (const skip of skipped) {
    output.status("!", output.warn(`Not deleted: ${skip.slug} (${skip.reason})`));
  }
  return skipped.length > 0 ? 1 : 0;
}

/** {@link printPlan}'s default for `--dry-run`, which has no apply to report from — printing falls back to prospective wording straight off `plan`. */
const EMPTY_APPLY_RESULT: RemovalApplyResult = { deleted: [], skipped: [], sourceDeleted: false };

/**
 * Print what the removal did, or would do.
 *
 * @param plan - The computed plan.
 * @param prospective - `true` for `--dry-run` wording, `false` once applied.
 * @param applied - What {@link applyRemovalLocked} actually did. Omitted for
 *   `--dry-run` (defaults to {@link EMPTY_APPLY_RESULT}), which never applies
 *   anything, so the plan itself is the only available source of truth.
 */
function printPlan(plan: RemovalPlan, prospective: boolean, applied: RemovalApplyResult = EMPTY_APPLY_RESULT): void {
  printDeleted(plan, prospective, applied);
  printKept(plan);
  printConsequences(plan);
}

/**
 * Print the source line and every "Would delete:"/"Deleted:" slug line.
 *
 * `--dry-run` (`prospective`) prints straight off the plan — every
 * `plan.deleteSlugs` — since there is no apply yet and the plan IS the whole
 * story.
 *
 * Once applied, the list comes from `applied.deleted` — what
 * `applyRemovalLocked` actually unlinked — NEVER from `plan.deleteSlugs`,
 * which can overstate reality: a slug the delete batch floor-skipped is
 * reported separately by `reportSkipped` as "Not deleted:", not here.
 *
 * Split from {@link printKept} — one concern each — to keep this file's
 * per-function complexity under `fallow`'s threshold.
 */
function printDeleted(plan: RemovalPlan, prospective: boolean, applied: RemovalApplyResult): void {
  const { verb, sourceRemoved, slugs } = deletionReport(plan, prospective, applied);
  printSourceLine(plan.sourceFile, verb, sourceRemoved);
  for (const slug of slugs) {
    output.status("x", `${verb}: wiki/concepts/${slug}.md`);
  }
}

/**
 * Resolve the three things the delete lines need from whichever side is
 * authoritative, ONCE, rather than re-deciding prospective-vs-applied at each
 * of the three use sites. `--dry-run` has no apply to read from, so the plan is
 * the whole story; once applied, every line must come from what
 * {@link applyRemovalLocked} reported doing.
 *
 * @param plan - The computed plan.
 * @param prospective - `true` for `--dry-run` wording, `false` once applied.
 * @param applied - What the apply actually did.
 * @returns The line verb, whether a source FILE was (or would be) removed, and
 *   the page slugs to list.
 */
function deletionReport(
  plan: RemovalPlan,
  prospective: boolean,
  applied: RemovalApplyResult,
): { verb: string; sourceRemoved: boolean; slugs: string[] } {
  if (prospective) {
    return { verb: "Would delete", sourceRemoved: plan.sourcePresent, slugs: plan.deleteSlugs };
  }
  return { verb: "Deleted", sourceRemoved: applied.sourceDeleted, slugs: applied.deleted };
}

/**
 * Print the one line about the source FILE, which is the only line whose
 * subject may already have been gone before this command ran.
 *
 * `rm` resolves a ref whose source file is absent but whose state entry
 * survives, because that pairing is an interrupted removal being resumed (see
 * `planRemoval`, `src/sources/removal.ts`). Claiming "Deleted: sources/x.md"
 * there would be false, and false in the one direction that matters: it would
 * tell a user recovering from a failure that the step they are retrying just
 * happened again. The fallback wording states only what is observably true —
 * the file is gone, the rest is not — since `rm` cannot know whether a failed
 * removal or the user unlinked it.
 *
 * @param sourceFile - Bare basename, e.g. `"research-notes.md"`.
 * @param verb - "Would delete" or "Deleted", from {@link deletionReport}.
 * @param removed - Whether a file was (or would be) unlinked at all.
 */
function printSourceLine(sourceFile: string, verb: string, removed: boolean): void {
  if (removed) {
    output.status("x", `${verb}: sources/${sourceFile}`);
    return;
  }
  output.status("i", output.dim(`sources/${sourceFile} was already gone — only its pages and state entry remain`));
}

/**
 * Print a "Kept:" line for every page a live source still contributes to.
 *
 * One list, not two: `applyRemovalLocked` REFUSES outright if ownership moved
 * between the plan and the lock, so by the time anything is printed the plan's
 * kept set is provably the current one. There is no second, race-preserved
 * bucket to distinguish.
 */
function printKept(plan: RemovalPlan): void {
  for (const slug of plan.keptSlugs) {
    output.status("i", output.dim(`Kept: wiki/concepts/${slug}.md (shared with other sources)`));
  }
}

/**
 * Print the "regenerated derived artifacts" line. Called from {@link
 * rmCommand} ONLY after `regenerateDerivedLocked` has actually returned —
 * never from {@link printPlan}, which now runs BEFORE regeneration so the
 * deletion report leads the transcript. Printing this from inside `printPlan`
 * would mean asserting the work is done before `regenerateDerivedLocked` even
 * starts; calling it here means a strict-mode embeddings throw (see
 * `regenerateDerivedLocked`'s docstring) propagates past this call site and
 * the line is correctly never printed.
 *
 * Deliberately says "index and MOC" only, never "and embeddings": the
 * embeddings step inside `regenerateDerivedLocked` already printed its own
 * true outcome — success, a warning, or (under `LLMWIKI_EMBED_STRICT`) a
 * throw — immediately before this line would run. Claiming "and embeddings"
 * here would restate that as a blanket success and could directly contradict
 * a warning the user just saw. (Wrapping the embeddings step in `withQuiet`
 * instead, as done for `acquireLock` in `src/import/run.ts:145`, was
 * considered and rejected: it would silence that warning rather than fix the
 * contradiction, and the warning is exactly what a command with no
 * confirmation prompt must not hide.) Index and MOC regen has no failure mode
 * to report, so asserting those two is still accurate.
 *
 * Gated on `deletedCount`, not `plan.deleteSlugs.length`: the pre-lock plan
 * can overstate what actually happened (a floor-skipped slug is planned but
 * never unlinked), so whether to print this line must come from what was
 * actually deleted, the same rule the `Deleted:` lines themselves follow.
 *
 * @param deletedCount - `applied.deleted.length` from `applyRemovalLocked`.
 */
function printRegenerated(deletedCount: number): void {
  if (deletedCount > 0) output.status("~", output.info("Regenerated index and MOC"));
}

/**
 * Warn that this is a profile project, so any typed entity pages the removed
 * source contributed to are untracked and were left untouched.
 *
 * UNCONDITIONAL on `plan.profileId !== null` — unlike the other two warnings
 * in {@link printConsequences}, which only fire when the plan found something
 * concrete to name. `rm` derives everything it deletes from
 * `state.sources[file].concepts`, a structure typed entity candidates never
 * populate (see `review-approve.ts`'s typed/default split), so there is no
 * ownership record to count against. Printing a count here would overclaim
 * knowledge `rm` doesn't have; printing nothing would let a profile project's
 * typed pages go silently unmentioned. Fires on every `rm` on a profile
 * project, `--dry-run` included, since dry-run is the only pre-flight check
 * this command has. Split out of `printConsequences` to keep its cyclomatic
 * complexity down, matching this file's existing one-concern-per-print-helper
 * shape (`printDeleted`, `printKept`, `printRegenerated`).
 */
function printProfileWarning(plan: RemovalPlan): void {
  if (plan.profileId === null) return;
  output.status("!", output.warn(`This project uses the \`${plan.profileId}\` profile.`));
  output.note(
    "Typed entity pages are not tracked to the source they came from, so `rm` cannot remove " +
      "them — only pages under wiki/concepts/.",
  );
  output.note("Any entity pages from this source remain and must be removed manually.");
}

/**
 * Warn that a kept page can still CITE the source just deleted.
 *
 * `rm` names the two kinds of collateral it can see precisely — a surviving
 * `[[wikilink]]` to a doomed page, and a pending candidate referencing the
 * source. Provenance damage is the third kind and the one it cannot count: a
 * kept page's body carries `^[<source>.md]` markers merged in from every
 * contributor, so preserving the page correctly still leaves markers pointing
 * at a file that no longer exists, and `broken-citation` is an ERROR-severity
 * lint rule (`src/linter/rules-citations.ts`). Naming that in the transcript
 * — the only record `rm` produces, since it has no confirmation prompt — is
 * the difference between a lint failure the user was warned about and one that
 * arrives from nowhere.
 *
 * A flat line, not a citation scan: parsing markers here would duplicate the
 * linter's multi-source and span-suffix handling on a destructive path, to
 * report something `llmwiki lint` already reports exactly. Gated on a kept page
 * existing at all, because a page that was DELETED takes its citations with it.
 */
function printCitationWarning(plan: RemovalPlan): void {
  if (plan.keptSlugs.length === 0) return;
  output.status("!", output.warn("Kept page(s) may still cite this source."));
  output.note("Run `llmwiki lint` to find any citations left pointing at it.");
}

/** Warn about what `rm` reports but deliberately does not repair, or cannot see at all. */
function printConsequences(plan: RemovalPlan): void {
  printProfileWarning(plan);
  printCitationWarning(plan);
  if (plan.brokenLinks.length > 0) {
    output.status("!", output.warn(`${plan.brokenLinks.length} surviving page(s) link to a deleted page:`));
    for (const link of plan.brokenLinks) output.note(`${link.file} -> [[${link.target}]]`);
    output.note("Run `llmwiki lint` for detail.");
  }
  if (plan.candidateRefs.length > 0) {
    output.status("!", output.warn(`${plan.candidateRefs.length} pending review candidate(s) reference this source.`));
    output.note("Run `llmwiki review list`.");
  }
}
