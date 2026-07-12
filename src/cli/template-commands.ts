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
import {
  templateTapAddCommand,
  templateTapListCommand,
  templateTapRefreshCommand,
  templateTapRemoveCommand,
  type TapAddOptions,
  type TapOutputOptions,
} from "../commands/template-tap.js";
import {
  templateRemoteInspectCommand,
  templateSearchCommand,
  templateVerifyCommand,
  type RemoteOutputOptions,
  type TemplateSearchOptions,
} from "../commands/template-remote.js";

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
    .description("Inspect one builtin id or qualified remote coordinate")
    .option("--json", "Print stable JSON for a remote coordinate")
    .action(async (id: string, options: RemoteOutputOptions) => runExitCodeCommand(() =>
      id.includes("/") ? templateRemoteInspectCommand(id, options) : templateInspectCommand(id).then(() => 0),
    ));

  template
    .command("search <query>")
    .description("Search accepted signed remote template indexes")
    .option("--tap <name>", "Search one configured tap")
    .option("--json", "Print stable JSON results")
    .action(async (query: string, options: TemplateSearchOptions) => runExitCodeCommand(() => templateSearchCommand(query, options)));

  template
    .command("verify <coordinate>")
    .description("Verify one qualified remote template package")
    .option("--json", "Print stable JSON provenance")
    .action(async (coordinate: string, options: RemoteOutputOptions) => runExitCodeCommand(() => templateVerifyCommand(coordinate, options)));

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

  registerTapCommands(template);
}

function registerTapCommands(template: Command): void {
  const tap = template.command("tap").description("Manage explicitly trusted template taps");
  tap.command("list").option("--json", "Print stable JSON").action(async (options: TapOutputOptions) =>
    runExitCodeCommand(() => templateTapListCommand(options)));
  tap.command("add <name> <index-url>")
    .requiredOption("--key-id <id>", "Trusted Ed25519 key id")
    .option("--key-file <path>", "Read base64 SPKI DER key from a file")
    .option("--key-base64 <value>", "Use a base64 SPKI DER key")
    .action(async (name: string, url: string, options: TapAddOptions) =>
      runExitCodeCommand(() => templateTapAddCommand(name, url, options)));
  tap.command("remove <name>").description("Disable a tap and retain trust history").action(async (name: string) =>
    runExitCodeCommand(() => templateTapRemoveCommand(name)));
  tap.command("refresh <name>").option("--json", "Print stable JSON").action(async (name: string, options: TapOutputOptions) =>
    runExitCodeCommand(() => templateTapRefreshCommand(name, options)));
}
