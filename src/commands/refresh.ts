/**
 * Commander action for `llmwiki refresh --stale [--dry-run]`. Resolves the set of
 * stale/orphaned pages, then either prints the plan (dry-run, no LLM/writes) or
 * delegates a scoped recompile to the compile pipeline via CompileOptions.
 * Repairs stale compiled knowledge; deliberately skips unrelated new sources.
 */

import { compileAndReport } from "../compiler/index.js";
import {
  resolveStaleRefresh,
  type RefreshPlan,
  type RefreshStateStatus,
} from "../compiler/refresh-plan.js";
import * as output from "../utils/output.js";

interface RefreshCommandOptions {
  stale?: boolean;
  dryRun?: boolean;
}

/** Pairs of [items, label, icon] for plan detail lines — data-driven to keep cyclomatic low. */
type PlanDetailRow = [items: string[], label: string, icon: string];

/**
 * Run the refresh command. Resolves the stale-refresh plan and either prints
 * it (--dry-run) or delegates a scoped recompile to the compile pipeline.
 * @param options - CLI options forwarded by Commander.
 * @param ensureProvider - Optional provider guard, invoked only on the live
 *   recompile path (never for dry-run or any early-exit path) so dry-run works
 *   with no API key configured.
 * @returns Exit code: 0 for success, 1 for usage/corrupt-state errors.
 */
export default async function refreshCommand(
  options: RefreshCommandOptions = {},
  ensureProvider?: () => void,
): Promise<number> {
  if (!options.stale) {
    output.status("!", output.warn("Usage: llmwiki refresh --stale [--dry-run]"));
    return 1;
  }
  const root = process.cwd();
  const { stateStatus, plan } = await resolveStaleRefresh(root);
  const stateExit = checkStateStatus(stateStatus);
  if (stateExit !== null) return stateExit;
  // The "ok" branch always carries a plan; this guard narrows the type
  // (and is defensive) so the live path below needs no non-null assertions.
  if (!plan) return 1;
  return runRefresh(root, plan, options, ensureProvider);
}

/**
 * Execute the scoped recompile after all pre-work guards have passed. Returns
 * early when nothing is stale. The provider guard fires only here on the live
 * path — never for dry-run — so `refresh --stale --dry-run` succeeds with no
 * API key configured.
 */
async function runRefresh(
  root: string,
  plan: RefreshPlan,
  options: RefreshCommandOptions,
  ensureProvider?: () => void,
): Promise<number> {
  if (!hasWork(plan)) {
    output.status("✓", output.success("Wiki is up to date — nothing to refresh."));
    return 0;
  }
  printPlan(plan);
  if (options.dryRun) {
    output.status("i", output.dim("Dry run — no files changed, no LLM calls made."));
    return 0;
  }
  maybeEnsureProvider(plan, ensureProvider);
  await compileAndReport(root, { changeFilter: plan.changeFilter, skipSeedPages: true });
  reportNewSkipped(plan.newSkipped);
  return 0;
}

/**
 * Invoke the provider guard only when the plan will trigger an LLM extraction.
 * Concept extraction runs solely for changed owners and their known-affected
 * co-contributors; with no changed owners, knownAffected is empty too
 * (findAffectedSources expands only from changed/new sources), so cleanup-only
 * plans (orphan/shared state repair) skip the guard and need no key.
 */
function maybeEnsureProvider(plan: RefreshPlan, ensureProvider?: () => void): void {
  const needsLLM = plan.changedOwners.length > 0 || plan.knownAffected.length > 0;
  if (needsLLM) ensureProvider?.();
}

/**
 * Return 1 for corrupt state, 0 for missing state, null to proceed.
 * Kept separate so refreshCommand's cyclomatic stays below threshold.
 */
function checkStateStatus(stateStatus: RefreshStateStatus): number | null {
  if (stateStatus === "corrupt") {
    output.status("✗", output.error(".llmwiki/state.json is unreadable — run `llmwiki compile` to rebuild it."));
    return 1;
  }
  if (stateStatus === "missing") {
    output.status("i", output.dim("No compiled wiki yet — run `llmwiki compile`."));
    return 0;
  }
  return null;
}

/** Emit the "new sources skipped" hint when the plan identified any. */
function reportNewSkipped(newSkipped: string[]): void {
  if (newSkipped.length === 0) return;
  output.status("i", output.dim(
    `${newSkipped.length} new source(s) skipped — run \`llmwiki compile\` to include new content.`,
  ));
}

/** Print the plan summary line and all non-empty category detail lines. */
function printPlan(plan: RefreshPlan): void {
  const modelSources = plan.changedOwners.length + plan.knownAffected.length;
  output.status("~", output.info(
    `Recompiling ${plan.recompiledPages.length} page(s) from ${modelSources} source(s) ` +
    `(${plan.changedOwners.length} changed + ${plan.knownAffected.length} known affected; more may be found during the run); ` +
    `${plan.sharedKeptPages.length} kept (shared, content not rebuilt); ` +
    `cleaning up ${plan.computedOrphanedPages.length} orphaned page(s).`,
  ));
  for (const [items, label, icon] of planDetailRows(plan)) {
    if (items.length > 0) output.status(icon, output.dim(`${label}: ${items.join(", ")}`));
  }
}

/**
 * True when the plan has any actionable work: pages to recompile, orphaned
 * pages to clean up, OR shared (partial-deletion) pages whose state needs
 * repairing (the deleted owner removed from state, content kept).
 */
function hasWork(plan: RefreshPlan): boolean {
  return (
    plan.recompiledPages.length > 0 ||
    plan.sharedKeptPages.length > 0 ||
    plan.computedOrphanedPages.length > 0
  );
}

/** Data-driven detail rows for the plan: [items, label, icon]. Keeps printPlan cyclomatic low. */
function planDetailRows(plan: RefreshPlan): PlanDetailRow[] {
  return [
    [plan.recompiledPages, "recompiled", "~"],
    [plan.sharedKeptPages, "kept (shared) — content not regenerated", "i"],
    [plan.computedOrphanedPages, "cleaned up (orphaned)", "⚠"],
    [plan.alreadyOrphanedPages, "already orphaned — no action", "i"],
    [plan.knownAffected, "known affected sources (more may be found during the run)", "~"],
    [plan.newSkipped, "new sources skipped", "i"],
  ];
}
