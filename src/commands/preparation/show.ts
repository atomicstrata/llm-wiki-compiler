/**
 * @file src/commands/preparation/show.ts
 * @description `llmwiki preparation show <runId>` — one run's durable state.
 *
 * AN ADAPTER, and nothing else (D-10-1). The reference-only projection, the
 * three-arm project readiness, the lookup taxonomy and the owner liveness
 * classification all live in the service.
 *
 * THE THREE OUTCOMES GET THREE EXIT CODES, and that is the whole reason the
 * service distinguishes them. `refused` (exit 1) is a settled fact about the
 * store — this run does not exist, or this is not a project. `unavailable`
 * (exit 2) is a fact about this OBSERVER — something could not be read, and the
 * same command may answer differently later or elsewhere. A script that retries
 * on 2 and reports on 1 is doing the right thing in both cases; one shared
 * failure code would have made that impossible to write.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type {
  ExecutionOwnerReportV1, PhaseReportV1, RunReportV1, ShowResultV1,
} from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation show`. */
export interface PreparationShowOptions {
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/** The exit code for an outcome that is not a successful read. */
const UNAVAILABLE_EXIT = 2;

/** Render the human view: the run, then the owner, then the phases. */
function renderRun(run: RunReportV1): void {
  output.status("✓", output.info(`${run.runId} — ${run.state}`));
  output.status(" ", output.dim(`  plan ${run.manifestDigest}`));
  output.status(" ", output.dim(
    `  ${run.transitionCount} transition(s), ${run.evidenceRefs.length} evidence ref(s)`));
  if (run.executionOwner !== null) renderOwner(run.executionOwner);
  for (const phase of run.phases) renderPhase(phase);
}

/**
 * Render the in-flight attempt's owner.
 *
 * THE GUIDANCE LINE IS THE POINT OF SHOWING THE OWNER AT ALL. A pid and a
 * classification are facts an operator then has to interpret; what they actually
 * need to know is whether waiting can ever help — so the retryable arm is an
 * informational icon and the rest are warnings.
 */
function renderOwner(owner: ExecutionOwnerReportV1): void {
  output.status(" ", output.dim(`  attempt ${owner.attemptId} under pid ${owner.pid} — ${owner.liveness}`));
  output.status(owner.retryable ? "i" : "!", output.warn(`  ${owner.guidance}`));
}

/** Render one phase by its content address, never by its output. */
function renderPhase(phase: PhaseReportV1): void {
  const evidence = phase.outputEvidenceDigest === null ? "no output" : phase.outputEvidenceDigest;
  output.status("~", output.info(
    `  phase ${phase.logicalPhaseId}: ${phase.state} (attempt ${phase.attemptCount}, ${evidence})`));
  // WHY, not only WHAT: a failed phase without its reason sends the operator
  // into the run record with a debugger, which is how the first ingest defect
  // had to be diagnosed. The code and detail are host-authored and durable.
  if (phase.problem !== null) {
    const detail = phase.problemDetail === null ? "" : ` — ${phase.problemDetail}`;
    output.status("~", output.info(`    reason: ${phase.problem}${detail}`));
  }
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: ShowResultV1, json: boolean): void {
  if (json) {
    emitJson(outcome);
    return;
  }
  if (outcome.status === "shown") {
    renderRun(outcome.run);
    return;
  }
  output.status("!", output.warn(outcome.status === "refused" ? outcome.reason : outcome.detail));
}

/** The exit code each outcome carries — see the file docblock. */
function exitCode(outcome: ShowResultV1): number {
  if (outcome.status === "shown") return 0;
  return outcome.status === "unavailable" ? UNAVAILABLE_EXIT : 1;
}

/** `llmwiki preparation show <runId>`. Returns the process exit code. */
export async function preparationShowCommand(
  root: string, runId: string, options: PreparationShowOptions = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await withQuietJson(json, () => cliPreparationService(root).show({ runId }));
  report(outcome, json);
  return exitCode(outcome);
}
