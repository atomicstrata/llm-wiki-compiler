/**
 * @file Registers `recover`: revert a crashed compile's journal.
 */

import type { Command } from "commander";
import { recoverCommand } from "@atomicstrata/llmwiki-core/modules/commands/recover";

/** Add the options and action of the `recover` command. */
export function registerRecoverCommand(command: Command): void {
  command
    .action(async () => {
      try {
        await recoverCommand();
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
