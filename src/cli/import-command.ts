/**
 * @file Registers `import`: bring in an OKF bundle.
 */

import type { Command } from "commander";
import importCommand from "@atomicstrata/llmwiki-core/modules/commands/import";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";

/** Add the options and action of the `import` command. */
export function registerImportCommand(command: Command): void {
  command
    .requiredOption("--okf <dir>", "Path to the OKF bundle directory to import")
    .option(
      "--trusted",
      "Write mapped pages directly into wiki/ instead of staging for review (you vouch for the bundle's contents and its self-declared provenance)",
    )
    .option("--dry-run", "Report what would be imported (and skipped) without writing anything")
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (options: { okf: string; trusted?: boolean; dryRun?: boolean; verbose?: boolean }) => {
      try {
        setVerbose(verboseEnabled(options.verbose));
        await importCommand(process.cwd(), options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
