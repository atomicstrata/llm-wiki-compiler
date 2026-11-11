/**
 * @file src/commands/workflow-advance.ts
 * @description Commander action for `llmwiki workflow advance`: advance an
 * active run by one stage and print the outcome and new position.
 *
 * Kept apart from `./workflow.js` because `../workflows/advance.js` imports the
 * core index entry point (its legacy `resolveCurrentStage` helper defaults to
 * the core profile reader). The CLI imports this module only when `advance`
 * runs, so `workflow list`, `status` and the other lifecycle commands do not
 * load that entry point.
 */

import * as output from "@atomicstrata/llmwiki-core/modules/utils/output";
import { advanceWorkflow } from "../workflows/advance.js";
import { printRunPosition } from "./workflow-shared.js";

/**
 * Advance an active run by one stage, printing the outcome + new position. The
 * typed lifecycle errors (`RunNotActiveError`/`RunUnavailableError`/`LockBusyError`)
 * propagate to the cli.ts action wrapper.
 *
 * @param runId - The run id to advance.
 * @returns The process exit code (always 0; failures throw).
 */
export async function workflowAdvanceCommand(runId: string): Promise<number> {
  const { run, outcome } = await advanceWorkflow(process.cwd(), runId);
  output.status("→", output.info(`outcome: ${outcome}`));
  printRunPosition(run);
  return 0;
}
