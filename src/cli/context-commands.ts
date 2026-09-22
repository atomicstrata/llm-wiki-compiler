/**
 * @file Read-only context and next-action CLI registration. Keeps command
 * options and presentation together without expanding the main entrypoint.
 */
import type { Command } from "commander";
import { nextCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { contextCommand, type ContextCommandOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { setVerbose } from "@atomicstrata/llmwiki-core/compiler-cli";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Register advisory commands with the main CLI verbose-option policy. */
export function registerContextCommands(program: Command, verboseEnabled: (flag?: boolean) => boolean): void {
  program
    .command("next")
    .description("Show the recommended next action for this llmwiki project (read-only)")
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .action(async (options: { json?: boolean }) =>
      runExitCodeCommand(() => nextCommand({ json: options.json })),
    );
  
  program
    .command("context <prompt>")
    .description(
      "Build an agent-ready evidence pack for <prompt> from the compiled wiki " +
        "(read-only; provider credentials optional — semantic retrieval is used " +
        "when available and falls back to lexical otherwise)",
    )
    .option("--budget <tokens>", "Approximate output token budget (default 8000)")
    .option("--format <format>", "Output format: json | markdown (default markdown)")
    .option("--json", "Emit the stable v1 JSON envelope (overrides --format)")
    .option("--depth <n>", "Graph neighborhood depth, default 1, max 2; 0 disables expansion")
    .option("--top-pages <n>", "Max primary pages (default 5, max 20)")
    .option("--top-chunks <n>", "Max semantic chunks (default 8, max 50)")
    .option("--omit-root", "Emit project.root as null for privacy")
    .option("--no-neighbors", "Suppress graph expansion (keeps neighbors/gaps as empty arrays)")
    .option(
      "--include-sources",
      "Populate primary[].sourceWindows from claim-level citation spans (max 20 windows, 30 lines each)",
    )
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (prompt: string, options: ContextCommandOptions & { verbose?: boolean }) => {
      setVerbose(verboseEnabled(options.verbose));
      return runExitCodeCommand(() => contextCommand(prompt, options));
    });
}
