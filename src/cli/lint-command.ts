/**
 * @file Registers `lint`: run rule-based quality checks against the wiki.
 */

import type { Command } from "commander";
import lintCommand from "@atomicstrata/llmwiki-core/modules/commands/lint";

/** Add the options and action of the `lint` command. */
export function registerLintCommand(command: Command): void {
  command
    .option("--tiered", "Separate broken content, model judgements, and stale derived views")
    .option("--fix-preview", "Preview deterministic repairs without applying them")
    .option("--fix-propose <n>", "Propose the nth previewed repair for review; applies nothing")
    .action(async (options: { tiered?: boolean; fixPreview?: boolean; fixPropose?: string }) => {
      try {
        await lintCommand({
          tiered: options.tiered,
          fixPreview: options.fixPreview,
          ...(options.fixPropose === undefined ? {} : { fixPropose: Number(options.fixPropose) }),
        });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
