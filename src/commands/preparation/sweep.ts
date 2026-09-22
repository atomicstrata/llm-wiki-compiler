/**
 * @file src/commands/preparation/sweep.ts
 * @description `llmwiki preparation sweep` — reclaim the leaves of every
 * preparation whose run is provably absent.
 *
 * AN ADAPTER, and nothing else (D-10-1). The gate-derived unit ticket, the
 * provably-absent-owner rule and the crash-resumable delete all live below;
 * what remains here is how three answers read.
 *
 * NOTHING-TO-SWEEP EXITS 0, and it is not folded in with a refusal. On a healthy
 * project that is the expected outcome of running this verb, so a non-zero exit
 * would make an operator's routine maintenance look like a failure and would make
 * the command useless in a script that checks status codes. An unreadable key —
 * a call that could not TELL whether there were orphans — is a refusal and exits
 * non-zero, because those are different facts and the exit code is where a
 * script reads the difference.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { SweepResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation sweep`. */
export interface PreparationSweepOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** The human line for one non-refused outcome. */
function sweptLine(outcome: Extract<SweepResultV1, { status: "swept" }>): string {
  // A RESUME IS ANNOUNCED. The operator asked to sweep and got the completion
  // of an earlier crashed attempt; saying so is the difference between an
  // honest report and a coincidence they have to work out.
  const verb = outcome.resumed ? "resumed and completed" : "swept";
  return `${verb}: ${outcome.objectCount} object(s), ` +
    `${outcome.bytesReclaimed} byte(s) reclaimed (unit ${outcome.unitId})`;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: SweepResultV1, json: boolean): void {
  if (json) {
    emitJson(outcome);
    return;
  }
  if (outcome.status === "refused") {
    output.status("!", output.warn(outcome.reason));
    return;
  }
  output.status("✓", output.info(outcome.status === "nothing-to-sweep"
    ? "no orphaned preparation bytes to reclaim"
    : sweptLine(outcome)));
}

/** `llmwiki preparation sweep`. Returns the process exit code. */
export async function preparationSweepCommand(
  root: string, options: PreparationSweepOptions = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await withQuietJson(json, () => cliPreparationService(root).sweep());
  report(outcome, json);
  return outcome.status === "refused" ? 1 : 0;
}
