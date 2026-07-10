/**
 * @file src/commands/workflow-adapt.ts
 * @description Commander actions for `llmwiki workflow adapt` and `workflow
 * project`.
 *
 * `adapt` previews (`--dry-run`, read-only) or applies (`--apply`) a run's
 * re-anchoring to a CHANGED workflow definition; `project` writes a DERIVED
 * markdown projection of a run to its workflow's `projectionFile` under `wiki/`.
 * Both resolve `process.cwd()`, call the matching core operation, and print
 * human-readable output. Extracted from `workflow.ts` (pure split, no behavior
 * change) to keep each command module under the file-size budget.
 */

import * as output from "../utils/output.js";
import { adaptDryRun, adaptApply, type AdaptationPlan } from "../workflows/adapt.js";
import { AdaptationRequiresConfirmError } from "../workflows/errors.js";
import { writeProjection } from "../workflows/projection.js";

/**
 * Print the FULL impact of a lossy adapt the operator is being asked to confirm:
 * the stage mapping, the dropped (unmappable) stages, and the wiki page refs the
 * drop would ORPHAN — so they see exactly what `--confirm` would do. Read from the
 * read-only dry-run plan; falls back to the typed error's fields if the plan can't
 * be re-derived.
 */
async function printLossyImpact(runId: string, err: AdaptationRequiresConfirmError): Promise<void> {
  const plan = (await adaptDryRun(process.cwd(), runId)).find((p) => p.runId === runId);
  const unmappable = plan?.unmappable ?? err.unmappable;
  const orphaned = plan?.orphanedOutputs ?? err.orphanedOutputs;
  console.error("\x1b[31mError:\x1b[0m lossy adaptation impact:");
  if (plan !== undefined) {
    const mapping = plan.stageMapping.map((m) => `${m.from}→${m.to}`).join(", ") || "(none)";
    console.error(`  mapping:    ${mapping}`);
  }
  console.error(`  dropped stage(s): ${unmappable.join(", ")}`);
  if (orphaned.length > 0) console.error(`  ORPHANED wiki page(s): ${orphaned.join(", ")}`);
  console.error("re-run with --confirm to apply this lossy adaptation");
}

/** Options accepted by `workflow adapt` (the dry-run/apply/confirm flags). */
export interface WorkflowAdaptOptions {
  /** Preview the plan(s) read-only (the default when neither flag is given). */
  dryRun?: boolean;
  /** Re-anchor the run to the active def (requires an explicit run-id). */
  apply?: boolean;
  /** Authorize a LOSSY apply (drop/cancel an unmappable current stage). */
  confirm?: boolean;
}

/**
 * Write a run's DERIVED markdown projection to its workflow's `projectionFile`
 * under `wiki/`. Prints the written path; a workflow that declares no projection
 * target prints a notice and exits 0 (`no-target`); an absent/unreadable run
 * exits NON-zero (`unavailable`, fail-visible). The projection is a one-way
 * `wiki/` output — it never mutates run state.
 *
 * @param runId - The run id to project.
 * @returns 0 when written or no-target; 1 when the run/store is unavailable.
 */
export async function workflowProjectCommand(runId: string): Promise<number> {
  const result = await writeProjection(process.cwd(), runId);
  if (result.status === "written") {
    output.status("+", output.success(`Wrote projection ${result.path}`));
    return 0;
  }
  if (result.status === "no-target") {
    output.status("·", "no projection target for this workflow");
    return 0;
  }
  console.error(`\x1b[31mError:\x1b[0m projection unavailable: ${result.detail}`);
  return 1;
}

/** Print one read-only adaptation plan (digest drift, mapping, unmappable, lossless/lossy). */
function printAdaptationPlan(plan: AdaptationPlan): void {
  const mapping = plan.stageMapping.map((m) => `${m.from}→${m.to}`).join(", ") || "(none)";
  console.log(`${plan.runId}  [${plan.lossless ? "lossless" : "lossy"}]`);
  console.log(`  digest:     ${plan.oldDigest.slice(0, 8)} → ${plan.newDigest.slice(0, 8)}`);
  console.log(`  mapping:    ${mapping}`);
  if (plan.unmappable.length > 0) console.log(`  unmappable: ${plan.unmappable.join(", ")}`);
}

/**
 * Preview the adaptation plan(s) for one run (by id) or every readable run —
 * READ-ONLY (no lock, no write). Always returns 0; `AdaptDryRunError` (an
 * unresolvable id / unreadable named run / unavailable store) propagates to the
 * cli.ts action wrapper (printed + exit 1).
 *
 * @param runId - When given, preview just this run; otherwise preview all.
 * @returns The process exit code (always 0 on a clean dry-run).
 */
async function runAdaptDryRun(runId: string | undefined): Promise<number> {
  const plans = await adaptDryRun(process.cwd(), runId);
  if (plans.length === 0) {
    output.status("·", "No workflow runs to adapt.");
    return 0;
  }
  output.header("Workflow adaptation plan");
  for (const plan of plans) printAdaptationPlan(plan);
  return 0;
}

/**
 * Re-anchor ONE run to the active def. An `AdaptationRequiresConfirmError` lists
 * the unmappable losses + the re-run hint and exits 1 (fail closed, the run is
 * unchanged); the other typed errors (`AlreadyCurrentError`/`UnknownWorkflowError`/
 * `RunUnavailableError`/`LockBusyError`) propagate to the cli.ts action wrapper.
 *
 * @param runId - The run id to re-anchor (required for apply).
 * @param confirm - True to authorize a lossy adaptation.
 * @returns The process exit code (0 on success; non-zero on a needed confirm).
 */
async function runAdaptApply(runId: string, confirm: boolean): Promise<number> {
  try {
    const run = await adaptApply(process.cwd(), runId, { confirm });
    const lossless = run.events.at(-1)?.decision === "lossless";
    output.status("+", output.success(`Adapted run ${run.runId} (${lossless ? "lossless" : "lossy"})`));
    console.log(`workflowDigest: ${run.workflowDigest.slice(0, 8)}`);
    console.log(`currentStage:   ${run.currentStage ?? "(none)"}`);
    return 0;
  } catch (err) {
    if (!(err instanceof AdaptationRequiresConfirmError)) throw err;
    await printLossyImpact(runId, err);
    return 1;
  }
}

/**
 * Adapt a workflow run to the changed definition. With no flag or `--dry-run`,
 * previews the plan(s) read-only (returns 0). With `--apply`, re-anchors the named
 * run (a run-id is REQUIRED — a bulk apply is refused). `--confirm` authorizes a
 * lossy apply. A needed-but-missing confirm prints the losses and exits 1.
 *
 * @param runId - The run id (required for `--apply`; optional for a dry-run).
 * @param options - The dry-run/apply/confirm flags.
 * @returns The process exit code.
 */
export async function workflowAdaptCommand(
  runId: string | undefined,
  options: WorkflowAdaptOptions,
): Promise<number> {
  if (!options.apply) return runAdaptDryRun(runId);
  if (runId === undefined) {
    console.error("\x1b[31mError:\x1b[0m --apply requires an explicit run-id");
    return 1;
  }
  return runAdaptApply(runId, options.confirm === true);
}
