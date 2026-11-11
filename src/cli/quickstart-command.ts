/**
 * @file Registers `quickstart`: ingest a source and compile it in one step.
 */

import type { Command } from "commander";
import quickstartCommand from "@atomicstrata/llmwiki-core/modules/commands/quickstart";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/modules/cli/shared";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/modules/compiler/concurrency";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";

interface QuickstartOptions {
  review?: boolean; open?: boolean; provider?: string;
  lang?: string; json?: boolean; concurrency?: string; verbose?: boolean;
}

/** Add the options and action of the `quickstart` command. */
export function registerQuickstartCommand(command: Command): void {
  command
    .option("--review", "Generate review candidates instead of mutating wiki/")
    .option("--no-open", "Skip the viewer handoff after a successful compile")
    .option(
      "--provider <name>",
      "Override LLMWIKI_PROVIDER for this run only (e.g. anthropic, codex-agent, openai, ollama)",
    )
    .option(
      "--lang <code>",
      "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
    )
    .option("--json", "Emit the quickstart JSON envelope instead of human output (implies --no-open)")
    .option(
      "--concurrency <n>",
      "Max concurrent LLM calls during the compile step (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
    )
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (source: string, options: QuickstartOptions) => {
      setVerbose(verboseEnabled(options.verbose));
      return runExitCodeCommand(() => quickstartCommand(source, {
        review: options.review,
        open: options.open,
        provider: options.provider,
        lang: options.lang,
        json: options.json,
        // Choose the warning channel here: argument expressions evaluate before the callee body runs.
        // Quickstart's own JSON quiet mode therefore can never intercept this warning.
        concurrency: parseConcurrencyFlag(options.concurrency, options.json ? "stderr" : "stdout"),
      }));
    });
}
