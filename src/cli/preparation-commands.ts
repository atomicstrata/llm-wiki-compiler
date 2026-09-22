/**
 * @file src/cli/preparation-commands.ts
 * @description Registers the `preparation` command group — the operator entry
 * point for preparation runs.
 *
 * THIS FILE IS THE POINT. The previous attempt at this task built a thirteen
 * operation service, a closed authority model and a lifecycle gate matrix with
 * no production caller anywhere in `src/`; fixtures then supplied whatever
 * shape the code expected, seven run states ended up with no emitter, and
 * nothing failed until a reviewer read it. The slice grows outward from this
 * registration, so every operation added after it is reachable by construction.
 *
 * `stage` creates a run from an operator document, `list` reads, and `fail`
 * drives one to the only terminal state the substrate can actually reach —
 * genesis to terminal, all through the binary. Breadth comes after that path
 * works, not before it.
 *
 * `cancel` and `recover` are the first operation FAMILY added on top of that
 * path, and they are the pair an operator reaches for when a run goes wrong:
 * `cancel` publishes the lock-free request that lands even on a wedged project,
 * and `recover` is the one verb the mutation gate lets through, so it can park a
 * stranded run and report the maintenance state everything else refuses on.
 *
 * `gate` is the second family, and it is the operator's authority verb: it
 * RECORDS a decision and performs nothing, so the authority another operation
 * consumes later is written down by a person rather than inferred. Its sibling
 * `handoff` has no verb here — its request carries host-authored compiled
 * material with no textual operator form — and that asymmetry is recorded on the
 * service rather than papered over with a verb that could only refuse.
 *
 * `prune` and `sweep` are the third family and the DESTRUCTIVE one: they are the
 * only verbs here that reclaim anything. Until they shipped, the reclamation
 * machinery existed inside `src/preparations` with no caller anywhere, so no
 * operator could reach it — `fail` drives a run terminal and reclaims nothing.
 * `prune` takes one eligible terminal run; `sweep` takes the leaves of
 * preparations whose runs are provably gone. They reclaim BYTES; they do not
 * free a workspace preparation slot, which the service records precisely.
 * Neither takes a confirmation flag: their preconditions are enforced where the
 * deletion happens, which is the only place a precondition can be honest.
 *
 * `reset` is the fourth family and it has ONE member, permanently. It is the
 * project-key repair, and it is the only verb here with no SDK sibling at all:
 * every other operation is on the service for any host that constructs it, while
 * reset refuses unless the host's own surface is `cli`. It DOES take a
 * confirmation flag, and the difference from `prune`/`sweep` is worth stating —
 * those reclaim bytes whose owner is already terminal or provably gone, whereas
 * this one quarantines every live preparation authority in the project. The
 * confirmation is the operator's explicit acknowledgement of that.
 *
 * ITS FLAG NAMES BOTH PHRASES, and that is a repair rather than a nicety. An
 * emergency verb that cannot be figured out is a defect, and this one was
 * measured being one: with `--confirm` absent, the answer was "requires its
 * distinct confirmation" naming neither phrase, and `--help` named neither
 * either — so an operator whose key was gone had no route to the string except
 * reading source. The ABSENT case is now answered here, because it needs no
 * knowledge of the key state; a phrase that is present but WRONG stays the
 * substrate's call, because that one does.
 */

import type { Command } from "commander";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationCancelCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationListCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationShowCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationPauseCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationResumeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationFailCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationGateCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationPruneCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationRecoverCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { RESET_CONFIRM_DESCRIPTION, RESET_TOKEN_DESCRIPTION, preparationResetCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationPreviewCommand, preparationStageCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { preparationSweepCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Register the `preparation` command group on the root program. */
export function registerPreparationCommands(program: Command): void {
  const preparation = program
    .command("preparation")
    .description("Inspect and drive preparation runs");
  registerReadVerbs(preparation);
  registerDriveVerbs(preparation);
}

/**
 * The verbs that write no project byte: enumerate, describe, and project.
 *
 * SPLIT FROM THE DRIVING VERBS because the group had grown past the point where
 * a reader could see which half of it mutates — and "does this verb write?" is
 * the first question anyone reading a command table asks.
 */
function registerReadVerbs(preparation: Command): void {
  preparation
    .command("list")
    .description("List preparation runs and any problems observed while reading them")
    .option("--json", "Emit the machine-readable envelope instead of the human table")
    .action(async (options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationListCommand(process.cwd(), options)));

  preparation
    .command("show <runId>")
    .description("Show one preparation run's durable state, by reference")
    .option("--json", "Emit the machine-readable envelope instead of the human lines")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationShowCommand(process.cwd(), runId, options)));

  preparation
    .command("preview <planFile>")
    .description("Report what staging this plan would do, writing nothing")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .option("--allowance <count>", "Control-transition budget to project against")
    .option("--seed <file>", "JSON file holding the plan's declared initial input")
    .action(async (planFile: string, options: { json?: boolean; allowance?: string; seed?: string }) =>
      runExitCodeCommand(() => preparationPreviewCommand(process.cwd(), planFile, options)));

}

/** The verbs that drive a run: stage, control, gate, hand off, and reclaim. */
function registerDriveVerbs(preparation: Command): void {
  preparation
    .command("stage <planFile>")
    .description("Stage an operator plan document as a new preparation run")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .option("--allowance <count>", "Control-transition budget for this run")
    .option("--seed <file>", "JSON file holding the plan's declared initial input")
    .action(async (planFile: string, options: { json?: boolean; allowance?: string; seed?: string }) =>
      runExitCodeCommand(() => preparationStageCommand(process.cwd(), planFile, options)));

  preparation
    .command("fail <runId>")
    .description("Drive one preparation run to the terminal failed state")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationFailCommand(process.cwd(), runId, options)));

  preparation
    .command("gate <runId> <gateId> <decision>")
    .description("Record a gate decision (approved|rejected|revised) on one preparation run")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .option("--reason <code>", "Reason code recorded on the gate proof")
    .action(async (runId: string, gateId: string, decision: string, options: { json?: boolean; reason?: string }) =>
      runExitCodeCommand(() => preparationGateCommand(process.cwd(), runId, gateId, decision, options)));

  preparation
    .command("pause <runId>")
    .description("Hold one preparation run at its durable safe checkpoint")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationPauseCommand(process.cwd(), runId, options)));

  // REGISTERED BESIDE `pause`, because the pair is the contract. A build that
  // offers the hold without the release is the shape review refused.
  preparation
    .command("resume <runId>")
    .description("Return one paused preparation run to running")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationResumeCommand(process.cwd(), runId, options)));

  preparation
    .command("cancel <runId>")
    .description("Request cancellation of one preparation run")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationCancelCommand(process.cwd(), runId, options)));

  preparation
    .command("recover <runId>")
    .description("Park one stranded preparation run and report lifecycle maintenance")
    .option("--json", "Emit the machine-readable envelope instead of the human lines")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationRecoverCommand(process.cwd(), runId, options)));

  preparation
    .command("prune <runId>")
    .description("Reclaim one retention-eligible terminal preparation run's bytes")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (runId: string, options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationPruneCommand(process.cwd(), runId, options)));

  preparation
    .command("sweep")
    .description("Reclaim the bytes of preparations whose runs are provably absent")
    .option("--json", "Emit the machine-readable envelope instead of the human line")
    .action(async (options: { json?: boolean }) =>
      runExitCodeCommand(() => preparationSweepCommand(process.cwd(), options)));

  // THE ONLY VERB WITH NO SDK SIBLING, and the asymmetry is the point rather
  // than an omission: `reset` is CLI-only, enforced in the service. Registering
  // it here is what makes the repair reachable at all — until it landed, the
  // approved runbook for a project whose key is gone ended at a harness that
  // does not exist.
  //
  // ONE VERB CARRYING THREE ARMS, because they are one operation: pass one takes
  // the confirmation alone, pass two adds the unit and secret pass one returned,
  // and `--supersede` clears a marker whose secret is lost. Three verbs would
  // report three operations where the closed table has one.
  preparation
    .command("reset")
    .description("Repair a project whose preparation key is missing or unreadable")
    .option("--confirm <phrase>", RESET_CONFIRM_DESCRIPTION)
    .option("--continue <unitId>", "Complete the pending reset recorded under this unit")
    .option("--token <secret>", RESET_TOKEN_DESCRIPTION)
    .option("--supersede", "Clear a pending reset intent whose continuation secret is lost")
    .option("--json", "Emit the machine-readable envelope instead of the human lines")
    .action(async (options: {
      confirm?: string; continue?: string; token?: string; supersede?: boolean; json?: boolean;
    }) => runExitCodeCommand(() => preparationResetCommand(process.cwd(), options)));
}
