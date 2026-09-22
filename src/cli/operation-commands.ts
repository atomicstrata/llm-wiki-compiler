/**
 * @file src/cli/operation-commands.ts
 * @description Registers the `operation` command group — the operator entry point
 * for the Milestone A operation-bundle execution/recovery engine. `list` and
 * `inspect` are read-only status surfaces; `resume`, `compensate`, and `cancel`
 * drive the existing locked recovery seams (or the lock-free cancel advisory) and
 * report the seam's outcome faithfully, exiting non-zero on any refusal/park.
 *
 * This is the direct operation-bundle operator surface. The design's unified
 * `review recovery ...` facade (one resolver adapting legacy candidates AND
 * operation bundles) is a later integration; these commands wire the engine seams
 * that facade will eventually share.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { operationListCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { operationInspectCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { operationResumeCommand, operationCompensateCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { operationCancelCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** A single `--json` machine-output flag shared by every subcommand. */
interface JsonOption {
  json?: boolean;
}

/** Register the read-only inspection commands: `list`, `inspect`. */
function registerOperationReadCommands(operationCmd: Command): void {
  operationCmd
    .command("list")
    .description("List operation bundles/runs (incl. parked/recovery-blocking) and the recovery state")
    .option("--json", "Emit the machine-readable envelope instead of the human table")
    .action(async (options: JsonOption) => runExitCodeCommand(() => operationListCommand(process.cwd(), options)));

  operationCmd
    .command("inspect <target>")
    .description("Show one run's full state, counters, outcomes, and pending cancel advisory (by run id or bundle id)")
    .option("--json", "Emit the machine-readable run envelope instead of the human summary")
    .action(async (target: string, options: JsonOption) => runExitCodeCommand(() => operationInspectCommand(process.cwd(), target, options)));
}

/** Register the recovery-drive commands: `resume`, `compensate`, `cancel`. */
function registerOperationDriveCommands(operationCmd: Command): void {
  operationCmd
    .command("resume <target>")
    .description("Resume a parked (or crash-interrupted) run toward settlement under the project lock")
    .option("--json", "Emit the machine-readable action envelope instead of the human summary")
    .action(async (target: string, options: JsonOption) => runExitCodeCommand(() => operationResumeCommand(process.cwd(), target, options)));

  operationCmd
    .command("compensate <target>")
    .description("Compensate a run's applied effects under the closed eligibility rule, under the project lock")
    .option("--json", "Emit the machine-readable action envelope instead of the human summary")
    .action(async (target: string, options: JsonOption) => runExitCodeCommand(() => operationCompensateCommand(process.cwd(), target, options)));

  operationCmd
    .command("cancel <target>")
    .description("Write the lock-free advisory cancellation request for a run (reports created|exists)")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (target: string, options: JsonOption) => runExitCodeCommand(() => operationCancelCommand(process.cwd(), target, options)));
}

/** Register the `operation` command group on `program`. */
export function registerOperationCommands(program: Command): void {
  const operationCmd = program
    .command("operation")
    .description("Inspect and drive operation-bundle execution/recovery (list, inspect, resume, compensate, cancel)");

  registerOperationReadCommands(operationCmd);
  registerOperationDriveCommands(operationCmd);
}
