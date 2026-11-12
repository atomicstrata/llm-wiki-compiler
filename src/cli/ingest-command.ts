/**
 * @file Registers `ingest`: add a URL or local file to sources/.
 */

import type { Command } from "commander";
import ingestCommand from "@atomicstrata/llmwiki-core/modules/commands/ingest";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";

/** Add the options and action of the `ingest` command. */
export function registerIngestCommand(command: Command): void {
  command
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (source: string, options: { verbose?: boolean }) => {
      try {
        setVerbose(verboseEnabled(options.verbose));
        await ingestCommand(source);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
