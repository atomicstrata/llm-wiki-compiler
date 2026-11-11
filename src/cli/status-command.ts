/**
 * @file Registers `status`: report project status.
 */

import type { Command } from "commander";
import statusCommand from "@atomicstrata/llmwiki-core/modules/commands/status";

/** Add the options and action of the `status` command. */
export function registerStatusCommand(command: Command): void {
  command
    .option("--json", "Emit the status snapshot as JSON (same shape as the MCP wiki_status tool)")
    .action(async (options: { json?: boolean }) => {
      try {
        const code = await statusCommand({ json: options.json });
        process.exit(code);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
