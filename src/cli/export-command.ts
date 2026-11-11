/**
 * @file Registers `export`: write wiki content to portable formats.
 */

import type { Command } from "commander";
import exportCommand from "@atomicstrata/llmwiki-core/modules/commands/export";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";

/** Add the options and action of the `export` command. */
export function registerExportCommand(command: Command): void {
  command
    .option("--target <name>", "Limit export to a single target format")
    .option(
      "--source <kind>",
      "For marp target: which pages to include — concepts, queries, or all (default: all)",
    )
    .option(
      "--project-id <id>",
      "Bridge identifier embedded in the JSON export envelope. Must match /^[a-z0-9][a-z0-9-]{0,62}$/.",
    )
    .option("--out <dir>", "Output directory for directory-style targets (e.g. okf)")
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (options: { target?: string; source?: string; projectId?: string; out?: string; verbose?: boolean }) => {
      try {
        setVerbose(verboseEnabled(options.verbose));
        await exportCommand(process.cwd(), options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
