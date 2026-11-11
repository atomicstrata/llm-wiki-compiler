/**
 * @file src/cli/workflow-adapt-commands.ts
 * @description Configures `workflow project` and `workflow adapt`, implemented
 * by `src/commands/workflow-adapt.ts`.
 */

import type { Command } from "commander";
import { workflowAdaptCommand, workflowProjectCommand } from "../commands/workflow-adapt.js";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the action of `workflow project`. */
export function configureWorkflowProject(command: Command): void {
  command
    .action(async (runId: string) => runExitCodeCommand(() => workflowProjectCommand(runId)));
}

/** Add the options and action of `workflow adapt`. */
export function configureWorkflowAdapt(command: Command): void {
  command
    .option("--dry-run", "Preview the adaptation plan(s) without changing anything (default)")
    .option("--apply", "Re-anchor the run to the active def (requires a run-id)")
    .option("--confirm", "Authorize a lossy adaptation (drop/cancel an unmappable stage)")
    .action(async (runId: string | undefined, options: { dryRun?: boolean; apply?: boolean; confirm?: boolean }) =>
      runExitCodeCommand(() => workflowAdaptCommand(runId, options)),
    );
}
