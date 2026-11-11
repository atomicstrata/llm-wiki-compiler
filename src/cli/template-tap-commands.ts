/**
 * @file src/cli/template-tap-commands.ts
 * @description Configures the `template tap` group: manage explicitly trusted
 * template taps.
 */
import type { Command } from "commander";
import { templateTapAddCommand, templateTapForgetCommand, templateTapListCommand, templateTapRefreshCommand, templateTapRemoveCommand, type TapAddOptions, type TapForgetOptions, type TapOutputOptions } from "@atomicstrata/llmwiki-core/modules/commands/template-tap";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the `template tap` subcommands. */
export function configureTemplateTap(tap: Command): void {
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
  tap.command("forget <name>").description("Permanently delete a tap and all retained trust history")
    .option("--yes", "Confirm the irreversible trust reset")
    .action(async (name: string, options: TapForgetOptions) =>
      runExitCodeCommand(() => templateTapForgetCommand(name, options)));
  tap.command("refresh <name>").option("--json", "Print stable JSON").action(async (name: string, options: TapOutputOptions) =>
    runExitCodeCommand(() => templateTapRefreshCommand(name, options)));
}
