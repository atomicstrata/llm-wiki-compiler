/**
 * @file src/cli/project-federation-commands.ts
 * @description Registers slice S6's commands on the `project` group:
 * `project federation search|links|quality|propose|review|approve|apply|read|queue|group`
 * against a host that offers `portable-federation/2`. Each names the host,
 * the receiver and the federation, and reads the caller's own credentials
 * from a file. There is no host or administration command.
 */

import type { Command } from "commander";
import {
  projectFederationApplyCommand, projectFederationApproveCommand, projectFederationGroupCommand, projectFederationLinksCommand,
  projectFederationProposeCommand, projectFederationQualityCommand, projectFederationQueueCommand, projectFederationReadCommand,
  projectFederationReviewCommand, projectFederationSearchCommand,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import type { OriginalsCommandKit } from "./project-originals-commands.js";

/** Add the options every federation command shares. */
function withFederationRef(command: Command): Command {
  return command
    .requiredOption("--host <url>", "The host that offers the federation")
    .requiredOption("--receiver <project>", "The receiver project the federation is opened on")
    .requiredOption("--federation <id>", "The host-issued federation id")
    .requiredOption("--credentials <file>", "A JSON file {token, shards: [{project, token}]} with YOUR OWN tokens; never printed");
}

/** Collect a repeatable option. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** Register the overview commands. */
function registerOverview(federation: Command, kit: OriginalsCommandKit): void {
  withFederationRef(federation.command("propose").description("Propose an overview of explicit leaf pages, each read with your own token."))
    .requiredOption("--slug <slug>", "The overview's slug under wiki/overviews/")
    .requiredOption("--title <title>", "The overview's title")
    .requiredOption("--child <project:path>", "One child page (repeat, at most eight)", collect)
    .action((options) => kit.exitWith(projectFederationProposeCommand(options)));
  withFederationRef(federation.command("review <proposal>").description("Read every overview candidate you may read, in full."))
    .action((proposal, options) => kit.exitWith(projectFederationReviewCommand(proposal, options)));
  withFederationRef(federation.command("approve <proposal>").description("Approve exactly the reviewed digests, with your own child tokens."))
    .requiredOption("--candidate <id>", "The candidate whose reviewed view is approved")
    .action((proposal, options) => kit.exitWith(projectFederationApproveCommand(proposal, options)));
  withFederationRef(federation.command("apply <approval>").description("Apply one approved overview, with your own child tokens."))
    .action((approval, options) => kit.exitWith(projectFederationApplyCommand(approval, options)));
  withFederationRef(federation.command("read <slug>").description("Read one committed overview."))
    .action((slug, options) => kit.exitWith(projectFederationReadCommand(slug, options)));
}

/** Register `project federation …` on the `project` group. */
export function registerFederationCommands(project: Command, kit: OriginalsCommandKit): void {
  const federation = project.command("federation")
    .description("Two shards and an overview (slice S6) on a host that offers portable-federation/2. Membership grants nothing.");
  withFederationRef(federation.command("search <text>").description("Merged search across the shards you hold tokens for."))
    .option("--limit <n>", "Most results (at most 50)")
    .action((text, options) => kit.exitWith(projectFederationSearchCommand(text, options)));
  withFederationRef(federation.command("links <shard> <id>").description("Resolve one page's explicit [[shard:…]] links."))
    .action((shard, id, options) => kit.exitWith(projectFederationLinksCommand(shard, id, options)));
  withFederationRef(federation.command("quality").description("The next default sampled-structure window of each shard."))
    .action((options) => kit.exitWith(projectFederationQualityCommand(options)));
  registerOverview(federation, kit);
  withFederationRef(federation.command("queue").description("One page of the receiver's recompile queue."))
    .option("--cursor <cursor>", "Resume after the previous page").option("--limit <n>", "Items per page (at most 50)")
    .action((options) => kit.exitWith(projectFederationQueueCommand(options)));
  withFederationRef(federation.command("group").description("Run grouped per-shard changes, each with its own preallocated id."))
    .requiredOption("--entries <file>", "A JSON array of source.add / scoped.apply entries")
    .action((options) => kit.exitWith(projectFederationGroupCommand(options)));
}
