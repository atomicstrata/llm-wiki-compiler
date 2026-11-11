/**
 * @file Registers `compile`: compile sources/ into the wiki.
 */

import type { Command } from "commander";
import compileCommand from "@atomicstrata/llmwiki-core/modules/commands/compile";
import { addProviderOption, applyProviderOption, type ProviderOption } from "@atomicstrata/llmwiki-core/modules/cli/provider-option";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/modules/compiler/concurrency";
import { applyLanguageOption } from "@atomicstrata/llmwiki-core/modules/utils/output-language";
import { applySourcesSectionOption } from "@atomicstrata/llmwiki-core/modules/utils/sources-section";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { verboseEnabled } from "./verbose.js";
import { readInstructions } from "./instructions.js";
import { requireCompileProvider } from "./require-provider.js";

interface CompileOptions extends ProviderOption {
  review?: boolean;
  lang?: string;
  sourcesSection?: boolean;
  pagesLimit?: boolean;
  instructions?: string;
  concurrency?: string;
  verbose?: boolean;
}

/** Add the options and action of the `compile` command. */
export function registerCompileCommand(command: Command): void {
  addProviderOption(command)
    .option("--no-pages-limit", "Remove the requested 3–8 concepts per source; allow source-supported results with no pages")
    .option("--instructions <path>", "Add UTF-8 project instructions for this compile (max 64 KiB); changing or omitting them recompiles affected pages")
    .option(
      "--review",
      "Write generated pages as review candidates under .llmwiki/candidates/ instead of mutating wiki/. Orphan-marking for deleted sources is deferred until the next non-review compile.",
    )
    .option(
      "--lang <code>",
      "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
    )
    .option(
      "--no-sources-section",
      "Stop requesting a trailing ## Sources section; changing this preference recompiles affected pages. Equivalent to LLMWIKI_SOURCES_SECTION=off; unset it and omit this flag to restore the default.",
    )
    .option(
      "--concurrency <n>",
      "Max concurrent LLM calls during compile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
    )
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (options: CompileOptions) => {
      try {
        applyProviderOption(options);
        setVerbose(verboseEnabled(options.verbose));
        applyLanguageOption(options.lang);
        applySourcesSectionOption(options.sourcesSection);
        const systemPolicy = await readInstructions(options.instructions);
        requireCompileProvider();
        await compileCommand({ review: options.review, concurrency: parseConcurrencyFlag(options.concurrency), systemPolicy,
          noPagesLimit: options.pagesLimit === false });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
