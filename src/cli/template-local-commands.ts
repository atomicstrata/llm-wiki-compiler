/**
 * @file src/cli/template-local-commands.ts
 * @description Configures the `template` subcommands that work on builtin and
 * installed templates: `list`, `inspect`, `status`, `update` and `init`.
 */
import type { Command } from "commander";
import { templateInspectCommand, templateInitCommand, templateListCommand, templateStatusCommand, templateUpdateCommand, type TemplateInitOptions, type TemplateStatusOptions, type TemplateUpdateOptions } from "@atomicstrata/llmwiki-core/modules/commands/template";
import { templateRemoteInspectCommand, type RemoteOutputOptions } from "@atomicstrata/llmwiki-core/modules/commands/template-remote";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the action of `template list`. */
export function configureTemplateList(command: Command): void {
  command
    .action(async () => runExitCodeCommand(() => templateListCommand().then(() => 0)));
}

/** Add the options and action of `template inspect`; a qualified coordinate inspects a remote package. */
export function configureTemplateInspect(command: Command): void {
  command
    .option("--json", "Print stable JSON for a remote coordinate")
    .action(async (id: string, options: RemoteOutputOptions) => runExitCodeCommand(() =>
      id.includes("/") ? templateRemoteInspectCommand(id, options) : templateInspectCommand(id).then(() => 0),
    ));
}

/** Add the options and action of `template status`. */
export function configureTemplateStatus(command: Command): void {
  command
    .option("--json", "Print a stable JSON status envelope")
    .action(async (options: TemplateStatusOptions) => runExitCodeCommand(() => templateStatusCommand(options)));
}

/** Add the options and action of `template update`. */
export function configureTemplateUpdate(command: Command): void {
  command
    .option("--dry-run", "Inspect compatibility without writing")
    .option("--to <version>", "Target exact remote template version")
    .option("--yes", "Confirm a compatible remote update non-interactively")
    .option("--json", "Print a stable JSON update plan")
    .action(async (id: string | undefined, options: TemplateUpdateOptions) =>
      runExitCodeCommand(() => templateUpdateCommand(id, options)),
    );
}

/** Add the options and action of `template init`. */
export function configureTemplateInit(command: Command): void {
  command
    .option("--file <path>", "Install a local template package JSON file")
    .option("--force", "Overwrite an existing profile only when the typed corpus is empty")
    .option("--yes", "Confirm a verified remote install non-interactively")
    .option("--json", "Print a stable JSON result for remote installs")
    .action(async (id: string | undefined, options: TemplateInitOptions) =>
      runExitCodeCommand(() => templateInitCommand(id, options)),
    );
}
