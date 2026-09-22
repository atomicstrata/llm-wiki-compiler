/**
 * @file src/commands/preparation/fail.ts
 * @description `llmwiki preparation fail <runId>` — drive one run to the
 * terminal `failed` state.
 *
 * AN ADAPTER, and nothing else (D-10-1). The readiness precheck, the
 * could-not-see refusal taxonomy, the `planned`-only precondition and the locked
 * append all live in the service; what remains here is the run id the operator
 * typed and the two ways they can be answered.
 *
 * LOCAL-OPERATOR ONLY. The grant the service charges is nominal on this surface,
 * because a CLI principal holds the local-operator set by transport. It is not
 * authorization today, and the file it moved from said so; that limit is
 * unchanged by moving it.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { FailResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation fail`. */
export interface PreparationFailOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: FailResultV1, json: boolean): void {
  if (json) {
    // `emitJson` writes RAW to stdout; `output.status` prefixes an icon, so the
    // envelope arrived as `i {"status":...}` and never parsed — on every single
    // invocation, success and refusal alike.
    emitJson(outcome);
    return;
  }
  if (outcome.status === "failed") {
    output.status("✓", output.info(`${outcome.runId} failed`));
    return;
  }
  output.status("!", output.warn(outcome.reason));
}

/** `llmwiki preparation fail <runId>`. Returns the process exit code. */
export async function preparationFailCommand(
  root: string, runId: string, options: PreparationFailOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK, through the one shared scope. Without it the lock
  // helper's "Another compilation is running." lands on stdout ahead of the
  // envelope and `JSON.parse` fails.
  const outcome = await withQuietJson(json, () => cliPreparationService(root).fail({ runId }));
  report(outcome, json);
  return outcome.status === "failed" ? 0 : 1;
}
