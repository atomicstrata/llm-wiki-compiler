/**
 * @file src/cli/template-remote-commands.ts
 * @description Configures the `template` subcommands that read signed remote
 * indexes and packages: `search` and `verify`.
 */
import type { Command } from "commander";
import { templateSearchCommand, templateVerifyCommand, type RemoteOutputOptions, type TemplateSearchOptions } from "@atomicstrata/llmwiki-core/modules/commands/template-remote";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the options and action of `template search`. */
export function configureTemplateSearch(command: Command): void {
  command
    .option("--tap <name>", "Search one configured tap")
    .option("--json", "Print stable JSON results")
    .action(async (query: string, options: TemplateSearchOptions) => runExitCodeCommand(() => templateSearchCommand(query, options)));
}

/** Add the options and action of `template verify`. */
export function configureTemplateVerify(command: Command): void {
  command
    .option("--json", "Print stable JSON provenance")
    .action(async (coordinate: string, options: RemoteOutputOptions) => runExitCodeCommand(() => templateVerifyCommand(coordinate, options)));
}
