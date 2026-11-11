/**
 * @file src/cli/template-commands.ts
 * @description Registers the `template` command group with Commander. The
 * group is intentionally thin: option parsing stays in the
 * `src/cli/template-*-commands.ts` modules, while registry inspection and
 * install behavior stay in `src/commands/template*.ts`. Each subcommand's
 * module loads when it runs, so `template list` does not load the remote, tap
 * and publish code.
 */
import type { Command } from "commander";
import { declareLazyCommands, type LazyCommand } from "./lazy-commands.js";

/** The template subcommands in help order, with the module that configures each. */
const TEMPLATE_COMMANDS: LazyCommand[] = [
  ["list", "List builtin profile templates",
    () => import("./template-local-commands.js").then((m) => m.configureTemplateList)],
  ["inspect [options] <id>", "Inspect one builtin id or qualified remote coordinate",
    () => import("./template-local-commands.js").then((m) => m.configureTemplateInspect)],
  ["search [options] <query>", "Search accepted signed remote template indexes",
    () => import("./template-remote-commands.js").then((m) => m.configureTemplateSearch)],
  // Listed without `[options]`, as help has always printed it.
  ["verify <coordinate>", "Verify one qualified remote template package",
    () => import("./template-remote-commands.js").then((m) => m.configureTemplateVerify)],
  ["publish", "Author, build, and verify template publisher distributions",
    () => import("./template-publish-commands.js").then((m) => m.configureTemplatePublish)],
  ["status [options]", "Report installed template provenance and profile drift",
    () => import("./template-local-commands.js").then((m) => m.configureTemplateStatus)],
  ["update [options] [id]", "Preview a builtin update or safely apply an exact remote update",
    () => import("./template-local-commands.js").then((m) => m.configureTemplateUpdate)],
  ["init [options] [id]", "Install a builtin, local, or qualified remote profile template",
    () => import("./template-local-commands.js").then((m) => m.configureTemplateInit)],
  ["tap", "Manage explicitly trusted template taps",
    () => import("./template-tap-commands.js").then((m) => m.configureTemplateTap)],
];

/** Register the `template` command group. */
export function registerTemplateCommands(template: Command): void {
  declareLazyCommands(template, TEMPLATE_COMMANDS);
}
