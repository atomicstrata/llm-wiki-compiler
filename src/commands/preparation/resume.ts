/**
 * @file src/commands/preparation/resume.ts
 * @description `llmwiki preparation resume <runId>` — return one paused run to
 * `running`.
 *
 * AN ADAPTER, and nothing else (D-10-1). The readiness precheck, the single
 * resumable state and its cross-check against the edge table, the refusals that
 * name the verb which does apply, and the locked append all live in the service.
 *
 * IT REPORTS `already-running` AS SUCCESS AND SAYS SO, for the same reason
 * `pause` distinguishes `already-paused`: an operator retrying after a lost
 * connection is asking whether THIS invocation moved the run, and the exit code
 * cannot carry that.
 *
 * LOCAL-OPERATOR ONLY. The grant the service charges is nominal on this surface,
 * because a CLI principal holds the local-operator set by transport — which is
 * exactly why the guarantee that a paused run is escapable is proven on the SDK
 * surface instead, where a principal holds only its explicit grants.
 */

import * as output from "../../utils/output.js";
import { withQuietJson } from "../../cli/shared.js";
import { emitJson } from "../operation/render.js";
import type { ResumeResultV1 } from "../../preparations/service.js";
import { cliPreparationService } from "./host.js";

/** CLI options for `preparation resume`. */
export interface PreparationResumeOptions {
  /** Emit the machine-readable envelope instead of the human line. */
  json?: boolean;
}

/** Render one outcome in whichever mode the operator asked for. */
function report(outcome: ResumeResultV1, json: boolean): void {
  if (json) {
    // `emitJson` writes RAW to stdout; `output.status` prefixes an icon, which
    // would leave the envelope unparseable on every invocation.
    emitJson(outcome);
    return;
  }
  if (outcome.status === "resumed") {
    const detail = outcome.transition === "already-running" ? " (already running)" : "";
    output.status("✓", output.info(`${outcome.runId} resumed${detail}`));
    return;
  }
  output.status("!", output.warn(outcome.reason));
}

/** `llmwiki preparation resume <runId>`. Returns the process exit code. */
export async function preparationResumeCommand(
  root: string, runId: string, options: PreparationResumeOptions = {},
): Promise<number> {
  const json = options.json === true;
  // QUIET AROUND THE WORK, through the one shared scope, so the lock helper's
  // progress lines cannot land on stdout ahead of the envelope.
  const outcome = await withQuietJson(json, () => cliPreparationService(root).resume({ runId }));
  report(outcome, json);
  return outcome.status === "resumed" ? 0 : 1;
}
