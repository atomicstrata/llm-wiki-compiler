/**
 * @file src/cli/workflow-run-commands.ts
 * @description Configures the `workflow` subcommands implemented by
 * `src/commands/workflow.ts`: the read-only `list`, `show`, `events` and
 * `status`, and the run lifecycle `start`, `submit`, `cancel`, `fail` and
 * `resume`.
 */

import type { Command } from "commander";
import {
  workflowListCommand,
  workflowShowCommand,
  workflowEventsCommand,
  workflowStartCommand,
  workflowStatusCommand,
  workflowCancelCommand,
  workflowFailCommand,
  workflowResumeCommand,
  workflowSubmitCommand,
} from "../commands/workflow.js";
import { exitOnError, runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the action of `workflow list`. */
export function configureWorkflowList(command: Command): void {
  command
    .action(async () => runExitCodeCommand(() => workflowListCommand()));
}

/** Add the action of `workflow show`. */
export function configureWorkflowShow(command: Command): void {
  command
    .action(async (workflowId: string) => runExitCodeCommand(() => workflowShowCommand(workflowId)));
}

/** Add the action of `workflow events`. */
export function configureWorkflowEvents(command: Command): void {
  command
    .action(async (runId: string) => runExitCodeCommand(() => workflowEventsCommand(runId)));
}

/** Add the action of `workflow status`. */
export function configureWorkflowStatus(command: Command): void {
  command
    .action(async (runId?: string) => runExitCodeCommand(() => workflowStatusCommand(runId)));
}

/** Add the options and action of `workflow start`. */
export function configureWorkflowStart(command: Command): void {
  command
    .option("--input <pair...>", "Run input as key=value (repeatable)")
    .action(exitOnError(workflowStartCommand));
}

/** Add the options and action of `workflow submit`. */
export function configureWorkflowSubmit(command: Command): void {
  command
    .option("--kind <kind>", "Output kind: page | relation | lifecycle-transition | artifact | human-input")
    .option("--entity-type <t>", "Target entity type (page/lifecycle-transition)")
    .option("--artifact-type <type>", "artifact type (for --kind artifact)")
    .option("--slug <s>", "Target entity/artifact slug (page/lifecycle-transition/artifact)")
    .option("--body-file <path>", "Page/artifact body file (page/artifact)")
    .option("--to-state <state>", "Target lifecycle state (lifecycle-transition)")
    .option("--evidence-file <path>", "JSON evidence file (lifecycle-transition)")
    .option("--output-file <path>", "JSON payload file (relation/human-input)")
    .action(exitOnError(workflowSubmitCommand));
}

/** Add the action of `workflow cancel`. */
export function configureWorkflowCancel(command: Command): void {
  command
    .action(exitOnError(workflowCancelCommand));
}

/** Add the options and action of `workflow fail`. */
export function configureWorkflowFail(command: Command): void {
  command
    .option("--detail <reason>", "Human-readable failure reason recorded on the run-failed event")
    .action(exitOnError(workflowFailCommand));
}

/** Add the action of `workflow resume`. */
export function configureWorkflowResume(command: Command): void {
  command
    .action(exitOnError(workflowResumeCommand));
}
