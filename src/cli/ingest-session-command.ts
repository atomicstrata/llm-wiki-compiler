/**
 * @file Registers `ingest-session`: add a coding-agent session export to sources/.
 */

import type { Command } from "commander";
import ingestSessionCommand from "@atomicstrata/llmwiki-core/modules/commands/ingest-session";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";

/** Add the options and action of the `ingest-session` command. */
export function registerIngestSessionCommand(command: Command): void {
  command
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (targetPath: string, options: { verbose?: boolean }) => {
      try {
        setVerbose(verboseEnabled(options.verbose));
        await ingestSessionCommand(targetPath);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
