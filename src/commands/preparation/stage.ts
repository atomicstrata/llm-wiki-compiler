/**
 * @file src/commands/preparation/stage.ts
 * @description `llmwiki preparation stage <planFile>` — turn an operator's plan
 * document into a durable preparation run.
 *
 * AN ADAPTER, and nothing else (D-10-1). The project preflight, the plan and
 * seed parsing, the locked staging call and the refusal-versus-fault
 * classification all live in the service, so the SDK stages the same way rather
 * than a parallel way. What is left here is the operator's own vocabulary: two
 * file arguments, an `--allowance` string, and how an outcome is printed.
 *
 * THE DOCUMENTS ARE BOUND, NOT READ. `--seed` is passed as a reader the service
 * calls only after the project preflight has passed, which is what keeps a bad
 * plan in a store-less directory reporting the missing store rather than the bad
 * plan. Reading the files here first would invert two shipped refusals.
 *
 * IT SERVES `preview` FROM THE SAME BODY, because the two verbs differ in the
 * service method and one word of output and in nothing else — same arguments,
 * same allowance parsing, same document binding, same envelope. Two adapters
 * would be two places for `--allowance` to be validated differently, and the
 * whole point of preview is that it cannot diverge from the stage it previews.
 */

import * as output from "../../utils/output.js";
import { emitJson } from "../operation/render.js";
import { DEFAULT_CONTROL_TRANSITION_ALLOWANCE } from "../../preparations/service.js";
import type { PreviewResultV1, StageResultV1 } from "../../preparations/service.js";
import { readOperatorDocument, readSeedDocument } from "./documents.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation stage`. */
export interface PreparationStageOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
  /** The control-transition budget this run is allowed. */
  allowance?: string;
  /** JSON file holding the bytes the plan's initial input set hashes to. */
  seed?: string;
}

/** Parse the operator's allowance, refusing anything that is not a real budget. */
function allowanceOf(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_CONTROL_TRANSITION_ALLOWANCE;
  const parsed = Number(raw);
  // A budget is a positive safe integer. `Number("")` is 0 and `Number("1e999")`
  // is Infinity, so neither a bare check nor `parseInt` is enough here.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Which of the two verbs this invocation is. */
type StageMode = "stage" | "preview";

/** Either verb's outcome, as the service answered it. */
type StageModeResult = StageResultV1 | PreviewResultV1;

/**
 * Render one outcome in whichever mode the operator asked for.
 *
 * THE PREVIEW LINE MUST NOT SAY "staged", and it no longer CAN. The service used
 * to hand preview the staging result verbatim — status `staged`, plus a run id
 * belonging to a run nothing created — and this adapter carried the whole weight
 * of not showing it. It now answers `previewed` and names no run, so the
 * envelope an operator or a script reads has nothing in it that looks like a
 * handle. What is left here is the vocabulary: the `mode` marker a `--json`
 * consumer already keys on, and the one human line each verb prints.
 */
function report(outcome: StageModeResult, json: boolean, mode: StageMode): void {
  if (json) {
    emitJson(mode === "stage" ? outcome : { ...outcome, mode: "preview" });
    return;
  }
  if (outcome.status === "refused") {
    output.status("!", output.warn(outcome.reason));
    return;
  }
  output.status("✓", output.info(successLine(outcome)));
}

/** The one line each verb reports on success — see {@link report}. */
function successLine(outcome: Exclude<StageModeResult, { status: "refused" }>): string {
  return outcome.status === "staged"
    ? `staged ${outcome.runId} in ${outcome.workspaceId}`
    : `preview only — nothing written; staging would produce a run in ${outcome.workspaceId}`;
}

/** Validate the operator's budget, then stage or preview through the service. */
async function decide(
  root: string, planFile: string, options: PreparationStageOptions, mode: StageMode,
): Promise<StageModeResult> {
  const allowance = allowanceOf(options.allowance);
  if (allowance === null) {
    return { status: "refused", reason: "--allowance must be a positive whole number" };
  }
  const service = cliPreparationService(root);
  const request = {
    documents: {
      plan: () => readOperatorDocument("plan", planFile),
      seed: () => readSeedDocument(options.seed),
    },
    controlTransitionAllowance: allowance,
  };
  return mode === "stage" ? service.stage(request) : service.preview(request);
}

/** `llmwiki preparation stage <planFile>`. Returns the process exit code. */
export async function preparationStageCommand(
  root: string, planFile: string, options: PreparationStageOptions = {},
): Promise<number> {
  return runStageMode(root, planFile, options, "stage");
}

/** `llmwiki preparation preview <planFile>`. Returns the process exit code. */
export async function preparationPreviewCommand(
  root: string, planFile: string, options: PreparationStageOptions = {},
): Promise<number> {
  return runStageMode(root, planFile, options, "preview");
}

/** The body both verbs share — see the file docblock. */
async function runStageMode(
  root: string, planFile: string, options: PreparationStageOptions, mode: StageMode,
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK in `--json` mode, as `list` does. The lock helper
  // prints "Another compilation is running." on stdout, which landed ahead of
  // the envelope and broke `JSON.parse` — the same hazard the sibling
  // documents, on the one path an operator hits when a build is in flight.
  if (json) output.setQuiet(true);
  let outcome: StageModeResult;
  try {
    outcome = await decide(root, planFile, options, mode);
  } finally {
    if (json) output.setQuiet(false);
  }
  report(outcome, json, mode);
  // ONE REFUSAL ARM, TWO SUCCESS WORDS. Keying on the refusal is what keeps a
  // verb whose success word changes from silently landing on exit 1.
  return outcome.status === "refused" ? 1 : 0;
}
