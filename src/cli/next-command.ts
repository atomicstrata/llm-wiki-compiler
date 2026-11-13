/**
 * @file src/cli/next-command.ts
 * @description Registers `next`: show the recommended next action for this
 * project (read-only). Kept apart from `context`, whose retrieval code `next`
 * never runs, so running `next` does not load it.
 */
import type { Command } from "commander";
import nextCommand from "@atomicstrata/llmwiki-core/modules/commands/next";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";

/** Add the options and action of the `next` command. */
export function registerNextCommand(command: Command): void {
  command
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .action(async (options: { json?: boolean }) =>
      runExitCodeCommand(() => nextCommand({ json: options.json })),
    );
}
