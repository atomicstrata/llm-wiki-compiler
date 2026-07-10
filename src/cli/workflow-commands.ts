/**
 * @file src/cli/workflow-commands.ts
 * @description Registers the `workflow` command group and its `action`/
 * `gate` sub-groups: run and inspect declarative profile workflows
 * (experimental). Kept together in one file because `action` and `gate`
 * are sub-commands of the same group-local `workflowCmd` const. Moved out
 * of `src/cli.ts` verbatim (pure move, no behavior change) as part of the
 * per-domain command split.
 */

import type { Command } from "commander";
import {
  workflowListCommand,
  workflowShowCommand,
  workflowEventsCommand,
  workflowStartCommand,
  workflowStatusCommand,
  workflowAdvanceCommand,
  workflowGateApproveCommand,
  workflowCancelCommand,
  workflowFailCommand,
  workflowResumeCommand,
  workflowAdaptCommand,
  workflowProjectCommand,
  workflowSubmitCommand,
  workflowActionListCommand,
  workflowActionShowCommand,
  workflowActionRunCommand,
} from "../commands/workflow.js";
import { runExitCodeCommand } from "./shared.js";

/** Register the read-only discovery/inspection commands: `list`, `show`, `events`, `status`, `advance`, `project`. */
function registerWorkflowInspectionCommands(workflowCmd: Command): void {
  workflowCmd
    .command("list")
    .description("List workflows declared in the active profile")
    .action(async () => runExitCodeCommand(() => workflowListCommand()));

  workflowCmd
    .command("show <workflow-id>")
    .description("Show one workflow's stages (reads/writes/gates), projectionFile, and actions")
    .action(async (workflowId: string) => runExitCodeCommand(() => workflowShowCommand(workflowId)));

  workflowCmd
    .command("events <run-id>")
    .description("Show one run's recorded audit events (the in-record events[] trail)")
    .action(async (runId: string) => runExitCodeCommand(() => workflowEventsCommand(runId)));

  workflowCmd
    .command("status [run-id]")
    .description("Show workflow run status (all runs, or one by id)")
    .action(async (runId?: string) => runExitCodeCommand(() => workflowStatusCommand(runId)));

  workflowCmd
    .command("advance <run-id>")
    .description("Advance a workflow run to the next stage")
    .action(async (runId: string) => runExitCodeCommand(() => workflowAdvanceCommand(runId)));

  workflowCmd
    .command("project <run-id>")
    .description("Write a DERIVED markdown projection of a run to its workflow's projectionFile")
    .action(async (runId: string) => runExitCodeCommand(() => workflowProjectCommand(runId)));
}

/** Register the run-lifecycle commands: `start`, `adapt`, `submit`, `cancel`, `fail`, `resume`. */
function registerWorkflowRunCommands(workflowCmd: Command): void {
  workflowCmd
    .command("start <workflow>")
    .description("Start a new run of a declared workflow")
    .option("--input <pair...>", "Run input as key=value (repeatable)")
    .action(async (workflow: string, options: { input?: string[] }) => {
      try {
        await workflowStartCommand(workflow, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  workflowCmd
    .command("adapt [run-id]")
    .description("Adapt a run to the changed workflow def (--dry-run preview, --apply re-anchor)")
    .option("--dry-run", "Preview the adaptation plan(s) without changing anything (default)")
    .option("--apply", "Re-anchor the run to the active def (requires a run-id)")
    .option("--confirm", "Authorize a lossy adaptation (drop/cancel an unmappable stage)")
    .action(async (runId: string | undefined, options: { dryRun?: boolean; apply?: boolean; confirm?: boolean }) =>
      runExitCodeCommand(() => workflowAdaptCommand(runId, options)),
    );

  workflowCmd
    .command("submit <run-id>")
    .description("Submit a stage output (page/relation/lifecycle/artifact) for the run's current stage")
    .option("--kind <kind>", "Output kind: page | relation | lifecycle-transition | artifact")
    .option("--entity-type <t>", "Target entity type (page/lifecycle-transition)")
    .option("--artifact-type <type>", "artifact type (for --kind artifact)")
    .option("--slug <s>", "Target entity/artifact slug (page/lifecycle-transition/artifact)")
    .option("--body-file <path>", "Page/artifact body file (page/artifact)")
    .option("--to-state <state>", "Target lifecycle state (lifecycle-transition)")
    .option("--evidence-file <path>", "JSON evidence file (lifecycle-transition)")
    .option("--output-file <path>", "JSON AppendRelationInput file (relation)")
    .action(async (runId: string, options) => {
      try {
        await workflowSubmitCommand(runId, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  registerWorkflowTerminationCommands(workflowCmd);
}

/** Register the terminal-state commands: `cancel`, `fail`, `resume`. */
function registerWorkflowTerminationCommands(workflowCmd: Command): void {
  workflowCmd
    .command("cancel <run-id>")
    .description("Cancel an active workflow run")
    .action(async (runId: string) => {
      try {
        await workflowCancelCommand(runId);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  workflowCmd
    .command("fail <run-id>")
    .description("Fail an active workflow run (move it to terminal failed; retryable via resume)")
    .option("--detail <reason>", "Human-readable failure reason recorded on the run-failed event")
    .action(async (runId: string, options: { detail?: string }) => {
      try {
        await workflowFailCommand(runId, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  workflowCmd
    .command("resume <run-id>")
    .description("Resume a failed workflow run (or report its position)")
    .action(async (runId: string) => {
      try {
        await workflowResumeCommand(runId);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}

/** Register the `workflow action` sub-group: `list`, `show`, `run` (read-only discovery + execution). */
function registerWorkflowActionCommands(workflowCmd: Command): void {
  const actionCmd = workflowCmd.command("action").description("Discover declared workflow actions (read-only)");

  actionCmd
    .command("list")
    .description("List workflow actions declared in the active profile")
    .action(async () => runExitCodeCommand(() => workflowActionListCommand()));

  actionCmd
    .command("show <action-id>")
    .description("Show one workflow action and its effective permission per surface")
    .action(async (actionId: string) => runExitCodeCommand(() => workflowActionShowCommand(actionId)));

  actionCmd
    .command("run <action-id>")
    .description("Run a declared workflow action under the composed authority")
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

/** Register the `workflow gate` sub-group: `approve`. */
function registerWorkflowGateCommands(workflowCmd: Command): void {
  const gateCmd = workflowCmd.command("gate").description("Workflow gate operations");

  gateCmd
    .command("approve <run-id> <gate-id>")
    .description("Approve a human/agent gate on a run's current stage")
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

/** Register the `workflow` command group and its `action`/`gate` sub-groups on `program`. */
export function registerWorkflowCommands(program: Command): void {
  const workflowCmd = program
    .command("workflow")
    .description("Run and inspect declarative profile workflows (experimental)");

  registerWorkflowInspectionCommands(workflowCmd);
  registerWorkflowRunCommands(workflowCmd);
  registerWorkflowActionCommands(workflowCmd);
  registerWorkflowGateCommands(workflowCmd);
}
