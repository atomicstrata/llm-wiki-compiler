/**
 * Commander registration for `llmwiki rules ...`.
 *
 * Keeping the rule-pipeline command tree outside `src/cli.ts` prevents the
 * entrypoint from becoming the dumping ground for every nested command while
 * leaving the actual rule actions in `commands/rules.ts`.
 */

import type { Command } from "commander";
import {
  rulesApproveCommand,
  rulesExportCommand,
  rulesExtractCommand,
  rulesListCommand,
  rulesRejectCommand,
} from "./rules.js";

/** Provider guard injected by the CLI entrypoint. */
type RequireProvider = () => void;

/**
 * Register the `rules` command group and its subcommands.
 * @param program - Root Commander program.
 * @param requireProvider - CLI provider guard for extraction.
 */
export function registerRulesCommand(program: Command, requireProvider: RequireProvider): void {
  const rulesCommand = program
    .command("rules")
    .description(
      "Extract, review, and export machine-actionable RuleCandidate records for a downstream rule importer",
    );

  registerExtract(rulesCommand, requireProvider);
  registerList(rulesCommand);
  registerApprove(rulesCommand);
  registerReject(rulesCommand);
  registerExport(rulesCommand);
}

/** Register `rules extract`. */
function registerExtract(rulesCommand: Command, requireProvider: RequireProvider): void {
  rulesCommand
    .command("extract")
    .description("Extract rule candidates from changed sources (writes .llmwiki/rule-candidates/)")
    .action(async () =>
      runRulesAction(async () => {
        requireProvider();
        await rulesExtractCommand();
      }),
    );
}

/** Register `rules list`. */
function registerList(rulesCommand: Command): void {
  rulesCommand
    .command("list")
    .description("List pending rule candidates")
    .action(async () => runRulesAction(() => rulesListCommand()));
}

/** Register `rules approve`. */
function registerApprove(rulesCommand: Command): void {
  rulesCommand
    .command("approve <id>")
    .description("Approve a rule candidate (status -> approved)")
    .action(async (id: string) => runRulesAction(() => rulesApproveCommand(id)));
}

/** Register `rules reject`. */
function registerReject(rulesCommand: Command): void {
  rulesCommand
    .command("reject <id>")
    .description("Reject a rule candidate (status -> rejected, archived)")
    .action(async (id: string) => runRulesAction(() => rulesRejectCommand(id)));
}

/** Register `rules export`. */
function registerExport(rulesCommand: Command): void {
  rulesCommand
    .command("export")
    .description("Emit rule candidates as a JSON array for the rule importer (dist/exports/rule-candidates.json)")
    .option("--scope <scope>", "approved (default), proposed, or all")
    .action(async (options: { scope?: string }) =>
      runRulesAction(() => rulesExportCommand(options)),
    );
}

/** Shared CLI error wrapper for the rule command group. */
async function runRulesAction(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
