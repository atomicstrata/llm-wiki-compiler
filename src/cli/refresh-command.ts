/**
 * @file Registers `refresh`: recompile only stale or changed pages.
 */

import type { Command } from "commander";
import refreshCommand from "@atomicstrata/llmwiki-core/modules/commands/refresh";
import { addProviderOption, applyProviderOption, type ProviderOption } from "@atomicstrata/llmwiki-core/modules/cli/provider-option";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/modules/compiler/concurrency";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";
import { requireCompileProvider } from "./require-provider.js";

/** Add the options and action of the `refresh` command. */
export function registerRefreshCommand(command: Command): void {
  addProviderOption(command)
    .option("--no-pages-limit", "Use source-supported extraction without a requested concept count during the scoped recompile")
    .option("--stale", "Resolve stale/orphaned pages and recompile them")
    .option("--dry-run", "Print the refresh plan without calling the LLM or writing files")
    .option(
      "--concurrency <n>",
      "Max concurrent LLM calls during the recompile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
    )
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (options: ProviderOption & { stale?: boolean; dryRun?: boolean; concurrency?: string; verbose?: boolean; pagesLimit?: boolean }) => {
      try {
        applyProviderOption(options);
        setVerbose(verboseEnabled(options.verbose));
        const code = await refreshCommand(
          { stale: options.stale, dryRun: options.dryRun, concurrency: parseConcurrencyFlag(options.concurrency),
            noPagesLimit: options.pagesLimit === false },
          requireCompileProvider,
        );
        process.exit(code);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
