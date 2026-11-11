/**
 * @file src/cli/workflow-commands.ts
 * @description Registers the `workflow` command group and its `action`/
 * `gate` sub-groups: run and inspect declarative profile workflows
 * (experimental). Each table below lists a group's subcommands in help order
 * with the module that configures each; that module loads when its subcommand
 * runs, so `workflow list` does not load the code (and core entry points)
 * behind `advance`, `adapt`, `gate` or `action run`.
 */

import type { Command } from "commander";
import { declareLazyCommands, type LazyCommand } from "./lazy-commands.js";

/** The `workflow` subcommands. */
const WORKFLOW_COMMANDS: LazyCommand[] = [
  ["list", "List workflows declared in the active profile",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowList)],
  ["show <workflow-id>", "Show one workflow's stages (reads/writes/gates), projectionFile, and actions",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowShow)],
  ["events <run-id>", "Show one run's recorded audit events (the in-record events[] trail)",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowEvents)],
  ["status [run-id]", "Show workflow run status (all runs, or one by id)",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowStatus)],
  ["advance <run-id>", "Advance a workflow run to the next stage",
    () => import("./workflow-advance-command.js").then((m) => m.configureWorkflowAdvance)],
  ["project <run-id>", "Write a DERIVED markdown projection of a run to its workflow's projectionFile",
    () => import("./workflow-adapt-commands.js").then((m) => m.configureWorkflowProject)],
  ["start [options] <workflow>", "Start a new run of a declared workflow",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowStart)],
  ["adapt [options] [run-id]", "Adapt a run to the changed workflow def (--dry-run preview, --apply re-anchor)",
    () => import("./workflow-adapt-commands.js").then((m) => m.configureWorkflowAdapt)],
  ["submit [options] <run-id>", "Submit a stage output (page/relation/lifecycle/artifact/human-input) for the current stage",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowSubmit)],
  ["cancel <run-id>", "Cancel an active workflow run",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowCancel)],
  ["fail [options] <run-id>", "Fail an active workflow run (move it to terminal failed; retryable via resume)",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowFail)],
  ["resume <run-id>", "Resume a failed workflow run (or report its position)",
    () => import("./workflow-run-commands.js").then((m) => m.configureWorkflowResume)],
  ["action", "Discover declared workflow actions (read-only)",
    () => Promise.resolve(registerWorkflowActionCommands)],
  ["gate", "Workflow gate operations",
    () => Promise.resolve(registerWorkflowGateCommands)],
];

/** The `workflow action` subcommands: read-only discovery and execution. */
const WORKFLOW_ACTION_COMMANDS: LazyCommand[] = [
  ["list", "List workflow actions declared in the active profile",
    () => import("./workflow-action-read-commands.js").then((m) => m.configureWorkflowActionList)],
  ["show <action-id>", "Show one workflow action and its effective permission per surface",
    () => import("./workflow-action-read-commands.js").then((m) => m.configureWorkflowActionShow)],
  ["run [options] <action-id>", "Run a declared workflow action under the composed authority",
    () => import("./workflow-action-run-command.js").then((m) => m.configureWorkflowActionRun)],
];

/** The `workflow gate` subcommands. */
const WORKFLOW_GATE_COMMANDS: LazyCommand[] = [
  ["approve [options] <run-id> <gate-id>", "Approve a human/agent gate on a run's current stage",
    () => import("./workflow-gate-command.js").then((m) => m.configureWorkflowGateApprove)],
];

/** Register the `workflow` command group and its `action`/`gate` sub-groups. */
export function registerWorkflowCommands(workflowCmd: Command): void {
  declareLazyCommands(workflowCmd, WORKFLOW_COMMANDS);
}

/** Register the `workflow action` sub-group. */
function registerWorkflowActionCommands(actionCmd: Command): void {
  declareLazyCommands(actionCmd, WORKFLOW_ACTION_COMMANDS);
}

/** Register the `workflow gate` sub-group. */
function registerWorkflowGateCommands(gateCmd: Command): void {
  declareLazyCommands(gateCmd, WORKFLOW_GATE_COMMANDS);
}
