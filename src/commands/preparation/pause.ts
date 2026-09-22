/**
 * @file src/commands/preparation/pause.ts
 * @description `llmwiki preparation pause <runId>` — hold one run at a durable
 * safe checkpoint.
 *
 * AN ADAPTER, and nothing else (D-10-1). The readiness precheck, the pausable
 * states derived from the edge table, the in-flight refusal and its per-liveness
 * remedy, and the locked append all live in the service; what remains here is the
 * run id the operator typed and the two ways they can be answered.
 *
 * IT REPORTS `already-paused` AS SUCCESS AND SAYS SO, rather than reporting a
 * bare "paused" for both. An operator re-running the verb after a lost connection
 * needs to know whether this invocation is what stopped the run, and the exit
 * code cannot carry that: both are success, and collapsing the wording would hide
 * the one fact the retry was asking about.
 *
 * LOCAL-OPERATOR ONLY. The grant the service charges is nominal on this surface,
 * because a CLI principal holds the local-operator set by transport.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { PauseResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation pause`. */
export interface PreparationPauseOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: PauseResultV1, json: boolean): void {
  if (json) {
    // `emitJson` writes RAW to stdout; `output.status` prefixes an icon, which
    // would leave the envelope unparseable on every invocation.
    emitJson(outcome);
    return;
  }
  if (outcome.status === "paused") {
    const detail = outcome.transition === "already-paused" ? " (already paused)" : "";
    output.status("✓", output.info(`${outcome.runId} paused${detail}`));
    return;
  }
  output.status("!", output.warn(outcome.reason));
}

/** `llmwiki preparation pause <runId>`. Returns the process exit code. */
export async function preparationPauseCommand(
  root: string, runId: string, options: PreparationPauseOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK, through the one shared scope, so the lock helper's
  // progress lines cannot land on stdout ahead of the envelope.
  const outcome = await withQuietJson(json, () => cliPreparationService(root).pause({ runId }));
  report(outcome, json);
  return outcome.status === "paused" ? 0 : 1;
}
