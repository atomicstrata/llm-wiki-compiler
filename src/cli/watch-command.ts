/**
 * @file Registers `watch`: recompile when sources/ changes.
 */

import type { Command } from "commander";
import watchCommand from "@atomicstrata/llmwiki-core/modules/commands/watch";
import { addProviderOption, applyProviderOption, type ProviderOption } from "@atomicstrata/llmwiki-core/modules/cli/provider-option";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/modules/compiler/concurrency";
import { requireCompileProvider } from "./require-provider.js";

/** Add the options and action of the `watch` command. */
export function registerWatchCommand(command: Command): void {
  addProviderOption(command)
    .option(
      "--concurrency <n>",
      "Max concurrent LLM calls per recompile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
    )
    .action(async (options: ProviderOption & { concurrency?: string }) => {
      try {
        applyProviderOption(options);
        requireCompileProvider();
        await watchCommand({ concurrency: parseConcurrencyFlag(options.concurrency) });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
