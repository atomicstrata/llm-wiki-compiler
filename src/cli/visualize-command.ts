/**
 * @file Registers `visualize`: write Obsidian graph configuration and Canvas maps.
 */

import type { Command } from "commander";
import visualizeCommand, { type VisualizeOptions } from "@atomicstrata/llmwiki-core/modules/commands/visualize";

/** Add the options and action of the `visualize` command. */
export function registerVisualizeCommand(command: Command): void {
  command
    .option("--focus <nodeId>", "Centre the canvas on one node, e.g. papers/alpha")
    .option("--depth <hops>", "Hops around --focus (default 1)")
    .action(async (options: VisualizeOptions) => {
      try {
        process.exitCode = await visualizeCommand(process.cwd(), options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
