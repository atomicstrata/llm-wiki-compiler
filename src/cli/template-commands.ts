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
  type TemplateInitOptions,
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
    .command("init [id]")
    .description("Install a builtin or local profile template into .llmwiki/profile.json")
    .option("--file <path>", "Install a local template package JSON file")
    .option("--force", "Overwrite an existing profile only when the typed corpus is empty")
    .action(async (id: string | undefined, options: TemplateInitOptions) =>
      runExitCodeCommand(() => templateInitCommand(id, options)),
    );
}
