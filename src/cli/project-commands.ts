/**
 * @file src/cli/project-commands.ts
 * @description Registers the `project` command group: the opt-in portable
 * project path. `project register` opts a directory in; every other subcommand
 * takes `--project <ref>` (a registered directory, or a host URL ending in a
 * project id with `--token`) and runs one operation of the portable journey.
 *
 * These commands never run a legacy command. A reference that cannot be opened
 * portably is refused, and an operation outside the prototype answers with a
 * typed refusal.
 *
 * This composition states no model, so `project propose` on a local directory
 * is refused with `capability_unsupported`; its help says so and names the
 * standard local route. This package ships no host: the hosted-client
 * subcommands (`originals`, `tiers`, `federation`) answer a typed refusal
 * against a local directory, and nothing here starts or provisions a host.
 */

import type { Command } from "commander";
import {
  projectApplyCommand, projectApprovalShowCommand, projectApproveCommand, projectCandidatesListCommand,
  projectCandidatesShowCommand, projectCapabilitiesCommand, projectDeferredCommand, projectExportCommand,
  projectPagesListCommand, projectPagesReadCommand, projectProposeCommand, projectRegisterCommand,
  projectResolveCommand, projectScaleCapabilitiesCommand, projectScaleOpenCommand,
  projectScalePagesCommand, projectScaleSearchCommand, projectSearchCommand, projectSourceAddCommand,
  projectStatusCommand, projectTicketIssueCommand, projectViewCommand,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { registerOriginalsCommands } from "./project-originals-commands.js";
import { registerTiersCommands } from "./project-tiers-commands.js";
import { registerFederationCommands } from "./project-federation-commands.js";
import { registerScopedCommands } from "./project-scoped-commands.js";

/** What `project propose --help` says about where the model comes from. */
const PROPOSE_HELP = `
Where the model comes from:
  A hosted project (--project <url>/<id>) proposes under the model its host configured.
  A local directory has no model in this CLI: the proposal is refused with
  "capability_unsupported". No model runs, no draft is generated and no page is
  published; the refusal is recorded as that operation's outcome. Reading, listing,
  searching and adding sources work without a model.
  To compile a local wiki, use the standard route: llmwiki compile.
  To propose on a local portable project from code, pass a model explicitly:
  openProject({ project: { localRoot }, credential: { kind: "local-os" }, localHostModel }).
  This CLI never falls back to a provider named in the environment.`;

/** Run a handler and exit with the code it returns. */
async function exitWith(run: Promise<number>): Promise<void> {
  process.exitCode = await run;
}

/** Add the options every project subcommand shares. */
function withProjectRef(command: Command): Command {
  return command
    .requiredOption("--project <ref>", "A registered project directory, or a host URL ending in a project id")
    .option("--token <token>", "Host or service token for a hosted project (or LLMWIKI_PROJECT_TOKEN)")
    .option("--service", "Authenticate as a service identity");
}

/** Add the options every write shares. */
function withWriteOptions(command: Command): Command {
  return withProjectRef(command)
    .option("--operation <id>", "Repeat an earlier call under its operation id")
    .option("--supersedes <id>", "The refused operation this new request replaces");
}

/** Add the options an approve shares: exactly the digests that were reviewed, and the requested expiry. */
function withApproveOptions(command: Command): Command {
  return withWriteOptions(command)
    .option("--candidate-set <digest>", "The reviewed candidate-set digest")
    .option("--plan <digest>", "The reviewed plan digest")
    .option("--dependencies <digest>", "The reviewed apply-dependencies digest")
    .option("--expires <iso>", "Requested expiry; the host caps it");
}

/** Register the review and approval subcommands. */
function registerReviewCommands(project: Command): void {
  const candidates = project.command("candidates").description("Inspect a proposal's candidates.");
  withProjectRef(candidates.command("list <proposal>").description("List a proposal's candidates."))
    .action((proposal, options) => exitWith(projectCandidatesListCommand(proposal, options)));
  withProjectRef(candidates.command("show <proposal> <candidate>")
    .description("Show the exact draft that would be written and what it replaces."))
    .action((proposal, candidate, options) => exitWith(projectCandidatesShowCommand(proposal, candidate, options)));
  withApproveOptions(project.command("approve <proposal>").description("Approve exactly the digests that were reviewed."))
    .action((proposal, options) => exitWith(projectApproveCommand(proposal, options)));
  const approval = project.command("approval").description("Inspect an approval.");
  withProjectRef(approval.command("show <approval>").description("Show an approval's bindings and custody."))
    .action((id, options) => exitWith(projectApprovalShowCommand(id, options)));
}

/** Register the apply, ticket, status and resolve subcommands. */
function registerPublicationCommands(project: Command): void {
  withWriteOptions(project.command("apply <approval>").description("Apply one approved candidate set."))
    .option("--ticket <id>", "Execution ticket, when applying as a service")
    .action((approval, options) => exitWith(projectApplyCommand(approval, options)));
  const ticket = project.command("ticket").description("Execution tickets for delegated apply.");
  withProjectRef(ticket.command("issue <approval>").description("Issue a single-use ticket for one approved apply."))
    .requiredOption("--service-actor <subject>", "The service identity that will apply")
    .option("--expires <iso>", "Requested expiry; the host caps it")
    .action((approval, options) => exitWith(projectTicketIssueCommand(approval, options)));
  withProjectRef(project.command("status <operation>").description("Report an operation's recorded outcome."))
    .action((operation, options) => exitWith(projectStatusCommand(operation, options)));
  withProjectRef(project.command("resolve <operation>").description("Resolve a parked operation."))
    .requiredOption("--decision <decision>", "retry-recovery | roll-back-own-writes | accept-external-bytes")
    .requiredOption("--reason <text>", "Why; recorded with the resolution")
    .action((operation, options) => exitWith(projectResolveCommand(operation, options)));
}

/** Register the read, search and export subcommands. */
function registerReadCommands(project: Command): void {
  const pages = project.command("pages").description("Read published pages.");
  withProjectRef(pages.command("list").description("List published pages."))
    .action((options) => exitWith(projectPagesListCommand(options)));
  withProjectRef(pages.command("read <id>").description("Read one published page."))
    .action((id, options) => exitWith(projectPagesReadCommand(id, options)));
  withProjectRef(project.command("search <query>").description("Keyword search over published pages (no model)."))
    .action((query, options) => exitWith(projectSearchCommand(query, options)));
  withProjectRef(project.command("export").description("Export curated content as a labelled object stream."))
    .requiredOption("--out <dir>", "Destination directory; written only when the export completes")
    .action((options) => exitWith(projectExportCommand(options)));
  withProjectRef(project.command("view").description("Start the read-only portable viewer on a loopback port."))
    .option("--port <port>", "Port to listen on (default: any free port)")
    .action((options) => exitWith(projectViewCommand(options)));
  withProjectRef(project.command("capabilities").description("Show what this project's storage guarantees."))
    .action((options) => exitWith(projectCapabilitiesCommand(options)));
  withProjectRef(project.command("deferred <operation>").description("Show the typed refusal of a deferred operation."))
    .action((operation, options) => exitWith(projectDeferredCommand(operation, options)));
}

/** Register the paged reads, beside the version 1 read commands. */
function registerScaleCommands(project: Command): void {
  const scale = project.command("scale")
    .description("Paged browsing and bounded search (slice S1). Needs a store with a catalog; others refuse by name.");
  withProjectRef(scale.command("pages").description("List one page of published pages; reads no page body."))
    .option("--cursor <cursor>", "The cursor printed with the previous page")
    .option("--limit <n>", "Page size; the host caps it")
    .action((options) => exitWith(projectScalePagesCommand(options)));
  withProjectRef(scale.command("open <id>").description("Open one published page."))
    .action((id, options) => exitWith(projectScaleOpenCommand(id, options)));
  withProjectRef(scale.command("search <query>").description("Keyword search under a declared scan budget (no model)."))
    .option("--limit <n>", "Most hits to return; the host caps it")
    .action((query, options) => exitWith(projectScaleSearchCommand(query, options)));
  withProjectRef(scale.command("capabilities").description("Show what this project's store declares at scale."))
    .action((options) => exitWith(projectScaleCapabilitiesCommand(options)));
}

/**
 * Add every `project` subcommand and subgroup to the declared `project` group.
 *
 * @param project - The `project` command the lazy table in `src/cli.ts` declared (name and description).
 */
export function registerProjectCommand(project: Command): void {
  project.command("register [dir]").description("Register a project directory for the portable path.")
    .action((dir) => exitWith(projectRegisterCommand(dir)));
  const source = project.command("source").description("Project sources.");
  withWriteOptions(source.command("add <file>").description("Add one source file."))
    .option("--name <name>", "Source name (defaults to the file name)")
    .action((file, options) => exitWith(projectSourceAddCommand(file, options)));
  withWriteOptions(project.command("propose").description("Run the compile in review mode and persist a proposal."))
    .addHelpText("after", PROPOSE_HELP)
    .action((options) => exitWith(projectProposeCommand(options)));
  registerReviewCommands(project);
  registerPublicationCommands(project);
  registerReadCommands(project);
  registerScaleCommands(project);
  registerScopedCommands(project, { withProjectRef, withWriteOptions, withApproveOptions, exitWith });
  registerOriginalsCommands(project, { withProjectRef, exitWith });
  registerTiersCommands(project, { withProjectRef, exitWith });
  registerFederationCommands(project, { withProjectRef, exitWith });
}
