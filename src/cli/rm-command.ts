/**
 * @file Registers `rm`: delete a source and the pages derived only from it.
 */

import type { Command } from "commander";
import { rmCommand } from "@atomicstrata/llmwiki-core/modules/commands/rm";

/** Add the options and action of the `rm` command. */
export function registerRmCommand(command: Command): void {
  command
    .option("--dry-run", "Print what would be deleted and kept without changing anything")
    .action(async (source: string, options: { dryRun?: boolean }) => {
      try {
        const code = await rmCommand(source, { dryRun: options.dryRun });
        process.exit(code);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
