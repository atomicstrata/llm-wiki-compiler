/**
 * @file src/cli/workflow-action-run-command.ts
 * @description Configures `workflow action run`, which runs a declared
 * workflow action under the composed authority.
 */

import type { Command } from "commander";
import { workflowActionRunCommand } from "../commands/workflow-action-run.js";

/** Add the options and action of `workflow action run`. */
export function configureWorkflowActionRun(command: Command): void {
  command
    .option("--input <pair...>", "Action input as key=value (repeatable, string-typed)")
    .option("--input-json <json>", "Action inputs as a JSON object (typed; merged over --input)")
    .action(async (actionId: string, options: { input?: string[]; inputJson?: string }) => {
      try {
        await workflowActionRunCommand(actionId, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
