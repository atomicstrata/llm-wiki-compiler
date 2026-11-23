/**
 * @file src/cli/project-scoped-commands.ts
 * @description Registers slice S2b's commands on the `project` group:
 * `project format adopt [dir]`, the explicit, per-project adoption of
 * portable format 2, and `project scoped …`, the disk scoped journey of a
 * registered directory that adopted it — propose a declared set of sources,
 * read its coverage and candidates, approve exactly what was reviewed, apply,
 * and ask where one source's canonical state stands.
 */

import type { Command } from "commander";
import {
  projectFormatAdoptCommand, projectScopedApplyCommand, projectScopedApproveCommand, projectScopedCandidatesListCommand,
  projectScopedCandidatesShowCommand, projectScopedCapabilitiesCommand, projectScopedCoverageCommand, projectScopedProposeCommand,
  projectScopedStatusCommand,
} from "@atomicstrata/llmwiki-core/compiler-cli";

/** The option helpers the `project` group shares. */
export interface ProjectCommandKit {
  withProjectRef(command: Command): Command;
  withWriteOptions(command: Command): Command;
  withApproveOptions(command: Command): Command;
  exitWith(run: Promise<number>): Promise<void>;
}

/** Register `project format adopt`. */
function registerFormatCommands(project: Command, kit: ProjectCommandKit): void {
  const format = project.command("format").description("The portable format of a registered directory.");
  format.command("adopt [dir]")
    .description("Adopt portable format 2 (explicit, no downgrade): older portable-aware binaries (verified: published 1.5.0) then refuse to modify it.")
    .action((dir) => kit.exitWith(projectFormatAdoptCommand(dir)));
}

/** Register the review subcommands of `project scoped`. */
function registerScopedReview(scoped: Command, kit: ProjectCommandKit): void {
  kit.withProjectRef(scoped.command("coverage <proposal>").description("Show what a scoped proposal covered, and why any source is incomplete."))
    .action((proposal, options) => kit.exitWith(projectScopedCoverageCommand(proposal, options)));
  const candidates = scoped.command("candidates").description("Inspect a scoped proposal's candidates.");
  kit.withProjectRef(candidates.command("list <proposal>").description("List a scoped proposal's candidates."))
    .action((proposal, options) => kit.exitWith(projectScopedCandidatesListCommand(proposal, options)));
  kit.withProjectRef(candidates.command("show <proposal> <candidate>").description("Show the exact draft and what it replaces."))
    .action((proposal, candidate, options) => kit.exitWith(projectScopedCandidatesShowCommand(proposal, candidate, options)));
  kit.withApproveOptions(scoped.command("approve <proposal>").description("Approve exactly the digests that were reviewed."))
    .action((proposal, options) => kit.exitWith(projectScopedApproveCommand(proposal, options)));
}

/** Register `project format` and `project scoped` on the `project` group. */
export function registerScopedCommands(project: Command, kit: ProjectCommandKit): void {
  registerFormatCommands(project, kit);
  const scoped = project.command("scoped")
    .description("Scoped proposals on a registered directory that adopted format 2 (slice S2b). Others refuse by name.");
  kit.withProjectRef(scoped.command("capabilities").description("Negotiate the disk scoped protocol."))
    .action((options) => kit.exitWith(projectScopedCapabilitiesCommand(options)));
  kit.withWriteOptions(scoped.command("propose").description("Compile exactly the named sources (and bounded co-owners) in review mode."))
    .requiredOption("--sources <names>", "Comma-separated source names under sources/")
    .option("--max-expanded <n>", "Co-owning sources that may be admitted beside the named ones")
    .option("--max-candidates <n>", "Candidates kept; beyond it their sources stay incomplete")
    .action((options) => kit.exitWith(projectScopedProposeCommand(options)));
  registerScopedReview(scoped, kit);
  kit.withWriteOptions(scoped.command("apply <approval>").description("Apply one approved scoped proposal with its canonical state."))
    .action((approval, options) => kit.exitWith(projectScopedApplyCommand(approval, options)));
  kit.withProjectRef(scoped.command("status <source>").description("Where one source's canonical state stands."))
    .action((source, options) => kit.exitWith(projectScopedStatusCommand(source, options)));
}
