/**
 * @file src/cli/project-tiers-commands.ts
 * @description Registers slice S4's commands on the `project` group:
 * `project tiers search|triage|promote|review|approve|apply` against a host
 * that offers both search tiers.
 */

import type { Command } from "commander";
import {
  projectTiersApplyCommand, projectTiersApproveCommand, projectTiersPromoteCommand, projectTiersReviewCommand,
  projectTiersSearchCommand, projectTiersTriageCommand,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import type { OriginalsCommandKit } from "./project-originals-commands.js";

/** Register `project tiers …` on the `project` group. */
export function registerTiersCommands(project: Command, kit: OriginalsCommandKit): void {
  const tiers = project.command("tiers")
    .description("One search over raw sources and truly reviewed pages, triage and S2 promotion (slice S4), on a host that offers both tiers.");
  kit.withProjectRef(tiers.command("search <query>").description("Keyword search over raw source chunks and reviewed pages, each with its provenance (no model)."))
    .option("--tiers <list>", "Comma-separated tiers to search: raw, reviewed (default both)")
    .option("--limit <n>", "Most results (default 20, at most 50)")
    .action((query, options) => kit.exitWith(projectTiersSearchCommand(query, options)));
  kit.withProjectRef(tiers.command("triage <source>").description("Compare one source with the other sources you may read; read-only, no model."))
    .action((source, options) => kit.exitWith(projectTiersTriageCommand(source, options)));
  kit.withProjectRef(tiers.command("promote <source>").description("Turn a finding into an ordinary scoped proposal over exactly that source."))
    .requiredOption("--digest <digest>", "The finding's source digest, as triage reported it; a changed source is refused")
    .requiredOption("--namespace <ns>", "The page namespace the proposal compiles into")
    .action((source, options) => kit.exitWith(projectTiersPromoteCommand(source, options)));
  kit.withProjectRef(tiers.command("review <proposal>").description("Read every candidate of a scoped proposal in full."))
    .action((proposal, options) => kit.exitWith(projectTiersReviewCommand(proposal, options)));
  kit.withProjectRef(tiers.command("approve <proposal>").description("Approve exactly the digests of one reviewed candidate. Needs candidate.approve; S2 does not itself forbid a proposer who holds that role."))
    .requiredOption("--candidate <id>", "The candidate whose reviewed view is approved")
    .action((proposal, options) => kit.exitWith(projectTiersApproveCommand(proposal, options)));
  kit.withProjectRef(tiers.command("apply <approval>").description("Apply one approved scoped proposal."))
    .action((approval, options) => kit.exitWith(projectTiersApplyCommand(approval, options)));
}
