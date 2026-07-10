/**
 * @file src/context/pack-warnings.ts
 * @description The top-level PACK-WARNING appenders `buildContextPack()` runs
 * over the assembled draft — extracted VERBATIM from `./build.ts` so the
 * orchestrator stays under the repository's 400 non-comment-line file budget.
 *
 * Each appender lifts one already-computed project-health signal into the
 * pack's top-level `warnings[]` so an agent SEES a degraded project rather
 * than receiving a silently-thinner pack:
 *   - {@link appendProjectWarnings} — pending review candidates, lint errors,
 *     and `--include-sources` line-range citations that produced no window;
 *   - {@link appendRelationStoreWarning} — a fail-closed relation-store read
 *     (corrupt / too-new / symlink / confinement) from the snapshot's profile
 *     problems;
 *   - {@link appendStandingRelationWarnings} — standing relation-precondition
 *     drift (a page still in a gated lifecycle state whose precondition no
 *     longer holds) and the distinct "cannot verify" store-read failure;
 *   - {@link appendArtifactWarning} — one or more hash-pinned artifactRef
 *     values that resolved to a non-`ok` health (dangling / bytes-tampered /
 *     hash-mismatch / schema-invalid / unreadable / store-unavailable);
 *   - {@link appendJournalWarning} — a pending/unavailable compile journal.
 *
 * All five are additive and byte-preserving for a healthy/default project:
 * when the signal is absent the input pack is returned with an identical
 * warnings list, so the default context pack stays byte-identical (the parity
 * suite pins this). Every appender is read-only — nothing here mutates disk.
 * Ordering is owned by the orchestrator in `./build.ts`, which calls them in a
 * fixed sequence between source-window materialization and budget trimming.
 */

import { isRelationStoreUnavailableProblem } from "../profile/block.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { ProjectState } from "../project/state.js";
import type { ViewerSnapshot } from "../viewer/types.js";
import type { NormalizedOptions } from "./build.js";
import type { ContextPack, ContextWarning } from "./types.js";

/**
 * Append `pending-candidates`, `lint-errors`, and
 * `source-window-unavailable` to the top-level warnings list.
 *
 * Runs AFTER source-window materialization so we can detect the gap
 * where `--include-sources` was on but a line-range citation
 * produced no window (path-confined rejection, missing source file,
 * 20-window cap reached, …). Runs BEFORE budget trimming so a
 * budget-induced window drop does NOT spuriously add the warning;
 * the trimmer mutates sourceWindows only after this pass.
 */
export function appendProjectWarnings(
  pack: ContextPack,
  state: ProjectState,
  options: NormalizedOptions,
): ContextPack {
  const warnings = [...pack.warnings];
  if (state.pendingCandidates > 0) {
    warnings.push({
      code: "pending-candidates",
      message:
        `${state.pendingCandidates} review candidate${state.pendingCandidates === 1 ? "" : "s"} ` +
        "pending approval. Run `llmwiki review list` to inspect.",
    });
  }
  const lintErrors = state.lint.entry?.errors ?? 0;
  if (lintErrors > 0) {
    warnings.push({
      code: "lint-errors",
      message: `Last lint run reported ${lintErrors} error${lintErrors === 1 ? "" : "s"}.`,
    });
  }
  if (options.includeSources && hasUnmaterializedSpans(pack)) {
    warnings.push({
      code: "source-window-unavailable",
      message:
        "One or more line-range citations did not produce a source window " +
        "(path-confined, missing source file, or per-pack window cap reached).",
    });
  }
  return { ...pack, warnings };
}

/**
 * Append a `relation-store-unavailable` warning when the snapshot's profile
 * summary reports a fail-closed relation-store read (corrupt / too-new / symlink
 * / confinement). Narrowed to the store-UNAVAILABLE problem via
 * {@link isRelationStoreUnavailableProblem} so an ordinary entity field-violation
 * or a healthy-store-but-stale-relations problem does NOT spuriously fire. A
 * default/healthy project has no such problem, so the pack is unchanged.
 */
export function appendRelationStoreWarning(pack: ContextPack, snapshot: ViewerSnapshot): ContextPack {
  const problem = snapshot.profile?.problems?.find(isRelationStoreUnavailableProblem);
  if (problem === undefined) return pack;
  const warning: ContextWarning = {
    code: "relation-store-unavailable",
    message: `Typed relations are unavailable: ${problem.message}`,
  };
  return { ...pack, warnings: [...pack.warnings, warning] };
}

/**
 * Append the STANDING relation-precondition warnings from the snapshot's profile
 * problems: a `lifecycle-relation-requirement-unmet` warning when at least one
 * typed page is CURRENTLY in a gated lifecycle state whose relation precondition
 * no longer holds (the first offending page's message is quoted so the agent sees
 * an actionable example), and a distinct `lifecycle-relation-requirement-unverifiable`
 * warning when the standing check could not read the relation store. Both are
 * derived from the SAME `snapshot.profile.problems` status/viewer/export surface,
 * so a healthy/non-gated snapshot has neither and the pack stays byte-identical.
 */
export function appendStandingRelationWarnings(pack: ContextPack, snapshot: ViewerSnapshot): ContextPack {
  const problems = snapshot.profile?.problems ?? [];
  const unmet = problems.filter((p) => p.kind === "lifecycle-relation-requirement-unmet");
  const unverifiable = problems.find((p) => p.kind === "lifecycle-relation-requirement-unverifiable");
  const warnings: ContextWarning[] = [];
  if (unmet.length > 0) {
    warnings.push({
      code: "lifecycle-relation-requirement-unmet",
      message:
        `${unmet.length} typed page${unmet.length === 1 ? "" : "s"} in a gated lifecycle state no ` +
        `longer satisfy a relation precondition (e.g. ${unmet[0].message}).`,
    });
  }
  if (unverifiable !== undefined) {
    warnings.push({ code: "lifecycle-relation-requirement-unverifiable", message: unverifiable.message });
  }
  return warnings.length > 0 ? { ...pack, warnings: [...pack.warnings, ...warnings] } : pack;
}

/**
 * Append an `artifact-ref-unhealthy` warning when the snapshot's profile summary
 * reports one or more `artifact-store` problems: a hash-pinned artifactRef (a
 * page field or a live relation attribute) that {@link checkArtifactRefs}
 * resolved to a non-`ok` health. Sourced from the SAME
 * `snapshot.profile.problems` list `block.ts`'s `collectProfileSummary` already
 * folds `artifactProblemViews` findings into for status/viewer, and
 * `export/profile-block.ts` mirrors for export — so context can never disagree
 * with them about which refs are unhealthy. Unlike
 * {@link appendRelationStoreWarning}'s single store-wide fault, an
 * `artifact-store` problem is emitted ONE PER unhealthy ref (mirroring
 * {@link appendStandingRelationWarnings}'s multi-instance shape), so this
 * quotes the count and the first offending ref's health verdict as an example
 * rather than assuming exactly one. A project with no `artifacts` block or no
 * unresolved ref has no such problem, so the pack is byte-identical.
 */
export function appendArtifactWarning(pack: ContextPack, snapshot: ViewerSnapshot): ContextPack {
  const problems = (snapshot.profile?.problems ?? []).filter((p) => p.kind === "artifact-store");
  if (problems.length === 0) return pack;
  const warning: ContextWarning = {
    code: "artifact-ref-unhealthy",
    message:
      `${problems.length} artifact reference${problems.length === 1 ? "" : "s"} failed ` +
      `verification (e.g. ${problems[0].message}).`,
  };
  return { ...pack, warnings: [...pack.warnings, warning] };
}

/**
 * Append an `incomplete-compile` / `journal-unavailable` warning when the
 * project's compile journal is pending / unavailable, via the SHARED read-only
 * {@link journalHealthWarning} mapper (the same signal status/lint/viewer/export
 * surface). A cleanly-compiled project's journal is `ok`, so the mapper returns
 * null and the pack is byte-identical. Read-only — the mapper never mutates disk.
 */
export async function appendJournalWarning(pack: ContextPack, root: string): Promise<ContextPack> {
  const warning = await journalHealthWarning(root);
  if (warning === null) return pack;
  return { ...pack, warnings: [...pack.warnings, warning] };
}

/** True when any primary page has line-range citations missing matching sourceWindows. */
function hasUnmaterializedSpans(pack: ContextPack): boolean {
  for (const entry of pack.primary) {
    const lineRangeCount = entry.citations.filter(
      (c) => c.start !== undefined && c.end !== undefined,
    ).length;
    if (lineRangeCount > entry.sourceWindows.length) return true;
  }
  return false;
}
