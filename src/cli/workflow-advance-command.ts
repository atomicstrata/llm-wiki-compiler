/**
 * @file src/cli/workflow-advance-command.ts
 * @description Configures `workflow advance`. Its implementation reaches the
 * core index entry point, so it has its own module and only `advance` loads it.
 */

import type { Command } from "commander";
import { workflowAdvanceCommand } from "../commands/workflow-advance.js";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the action of `workflow advance`. */
export function configureWorkflowAdvance(command: Command): void {
  command
    .action(async (runId: string) => runExitCodeCommand(() => workflowAdvanceCommand(runId)));
}
