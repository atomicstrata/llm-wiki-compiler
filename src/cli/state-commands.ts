/**
 * @file src/cli/state-commands.ts
 * @description Registers the `state` command group: back up and reset
 * `.llmwiki/state.json`, used to recover a project state written by a
 * newer llmwiki version. Moved out of `src/cli.ts` verbatim (pure move,
 * no behavior change) as part of the per-domain command split.
 */

import type { Command } from "commander";
import { stateResetCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Register the `state` command group (currently just `state reset`) on `program`. */
export function registerStateCommands(program: Command): void {
  const stateCommand = program
    .command("state")
    .description(
      "Back up and reset .llmwiki/state.json (recovery for a state written by a newer llmwiki version).",
    );

  stateCommand
    .command("reset")
    .description("Back up and reset the project state file. Requires --yes to apply.")
    .option("--yes", "Apply the reset (back up and remove the state file)")
    // Scoped execution consumes exactly the previewed enumeration.
    .option("--scope <scope>", "state|wiki|raw|log|checkpoints|all — every scope PREVIEWS its per-file plan without --yes and DELETES those files with it")
    .action(async (options: { yes?: boolean; scope?: string }) => {
      try {
        await stateResetCommand({ yes: options.yes, scope: options.scope });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
