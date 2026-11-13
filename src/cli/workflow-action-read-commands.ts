/**
 * @file src/cli/workflow-action-read-commands.ts
 * @description Configures the read-only `workflow action list` and
 * `workflow action show` discovery commands.
 */

import type { Command } from "commander";
import { workflowActionListCommand, workflowActionShowCommand } from "../commands/workflow-action.js";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the action of `workflow action list`. */
export function configureWorkflowActionList(command: Command): void {
  command
    .action(async () => runExitCodeCommand(() => workflowActionListCommand()));
}

/** Add the action of `workflow action show`. */
export function configureWorkflowActionShow(command: Command): void {
  command
    .action(async (actionId: string) => runExitCodeCommand(() => workflowActionShowCommand(actionId)));
}
