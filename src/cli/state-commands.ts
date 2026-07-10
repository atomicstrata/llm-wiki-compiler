/**
 * @file src/cli/state-commands.ts
 * @description Registers the `state` command group: back up and reset
 * `.llmwiki/state.json`, used to recover a project state written by a
 * newer llmwiki version. Moved out of `src/cli.ts` verbatim (pure move,
 * no behavior change) as part of the per-domain command split.
 */

import type { Command } from "commander";
import { stateResetCommand } from "../commands/state-reset.js";

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
    .action(async (options: { yes?: boolean }) => {
      try {
        await stateResetCommand({ yes: options.yes });
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
