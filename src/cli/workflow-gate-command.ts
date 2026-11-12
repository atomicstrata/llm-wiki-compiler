/**
 * @file src/cli/workflow-gate-command.ts
 * @description Configures `workflow gate approve`, which approves a
 * human/agent gate on a run's current stage.
 */

import type { Command } from "commander";
import { workflowGateApproveCommand } from "../commands/workflow-gate.js";

/** Add the options and action of `workflow gate approve`. */
export function configureWorkflowGateApprove(command: Command): void {
  command
    .option("--actor <kind>", "Approving actor kind for a non-human gate: agent (default) or system (a human gate is approved via interactive confirmation)")
    .option("--actor-label <label>", "Optional human-readable actor label")
    .action(async (runId: string, gateId: string, options: { actor?: string; actorLabel?: string }) => {
      try {
        await workflowGateApproveCommand(runId, gateId, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
