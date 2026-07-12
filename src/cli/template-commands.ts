/**
 * @file src/cli/template-commands.ts
 * @description Registers the `template` command group with Commander. The
 * group is intentionally thin: parsing stays here, while registry inspection
 * and install behavior stay in `src/commands/template.ts`.
 */
import type { Command } from "commander";
import {
  templateInspectCommand,
  templateInitCommand,
  templateListCommand,
  templateStatusCommand,
  templateUpdateCommand,
  type TemplateInitOptions,
  type TemplateStatusOptions,
  type TemplateUpdateOptions,
} from "../commands/template.js";
import { runExitCodeCommand } from "./shared.js";

/** Register template list, inspect, and init commands. */
export function registerTemplateCommands(program: Command): void {
  const template = program
    .command("template")
    .description("List, inspect, and install profile templates");

  template
    .command("list")
    .description("List builtin profile templates")
    .action(async () => runExitCodeCommand(() => templateListCommand().then(() => 0)));

  template
    .command("inspect <id>")
    .description("Inspect one builtin profile template")
    .action(async (id: string) => runExitCodeCommand(() => templateInspectCommand(id).then(() => 0)));

  template
    .command("status")
    .description("Report installed template provenance and profile drift")
    .option("--json", "Print a stable JSON status envelope")
    .action(async (options: TemplateStatusOptions) => runExitCodeCommand(() => templateStatusCommand(options)));

  template
    .command("update [id]")
    .description("Preview compatibility with a builtin template update")
    .option("--dry-run", "Required: inspect compatibility without writing")
    .option("--json", "Print a stable JSON update plan")
    .action(async (id: string | undefined, options: TemplateUpdateOptions) =>
      runExitCodeCommand(() => templateUpdateCommand(id, options)),
    );

  template
    .command("init [id]")
    .description("Install a builtin or local profile template into .llmwiki/profile.json")
    .option("--file <path>", "Install a local template package JSON file")
    .option("--force", "Overwrite an existing profile only when the typed corpus is empty")
    .action(async (id: string | undefined, options: TemplateInitOptions) =>
      runExitCodeCommand(() => templateInitCommand(id, options)),
    );
}
