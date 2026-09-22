/**
 * @file src/commands/preparation/prune.ts
 * @description `llmwiki preparation prune <runId>` — reclaim one eligible
 * terminal run's bytes.
 *
 * AN ADAPTER, and nothing else (D-10-1). The derived unit ticket, the gated
 * destructive acquisition, the retention floor, the bundle reference check and
 * the crash-resume all live in the service and the substrate beneath it; what
 * remains here is the run id the operator typed and how the answers read.
 *
 * THERE IS NO CONFIRMATION FLAG, and that is a decision worth seeing rather than
 * inferring from its absence. A `--yes` would be a second, weaker gate in front
 * of the real ones: a run's bytes are eligible only when it is TERMINAL, thirty
 * days past its last transition, and — if it was handed off — its Milestone A
 * bundle re-reads and verifies. Those preconditions are what make the deletion
 * safe, they are enforced where the deletion happens, and a prompt in front of
 * them would suggest the operator's attention is the thing standing between a
 * live run and its destruction. It is not.
 *
 * WHAT THE LINE SAYS IS THE POINT, for a verb whose effect cannot be undone: it
 * names the unit whose signed receipt records exactly what was deleted, so an
 * operator can go and read the durable record rather than trust this line.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { PruneResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation prune`. */
export interface PreparationPruneOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: PruneResultV1, json: boolean): void {
  if (json) {
    emitJson(outcome);
    return;
  }
  if (outcome.status === "refused") {
    output.status("!", output.warn(outcome.reason));
    return;
  }
  // A RESUME IS ANNOUNCED. The operator asked to prune a run and got the
  // completion of an earlier crashed attempt; saying so is the difference
  // between an honest report and a coincidence they have to work out.
  const verb = outcome.resumed ? "resumed and completed" : "pruned";
  output.status("✓", output.info(
    `${outcome.runId} ${verb}: ${outcome.objectCount} object(s), ` +
    `${outcome.bytesReclaimed} byte(s) reclaimed (unit ${outcome.unitId})`,
  ));
}

/** `llmwiki preparation prune <runId>`. Returns the process exit code. */
export async function preparationPruneCommand(
  root: string, runId: string, options: PreparationPruneOptions = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await withQuietJson(json, () => cliPreparationService(root).prune({ runId }));
  report(outcome, json);
  return outcome.status === "refused" ? 1 : 0;
}
