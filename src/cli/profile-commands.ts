/**
 * @file src/cli/profile-commands.ts
 * @description Registers the `profile` command group: read-only inspection
 * of the active wiki profile (`profile show`, `profile validate`,
 * `profile diff`). Moved out of `src/cli.ts` verbatim (pure move, no
 * behavior change) as part of the per-domain command split.
 */

import type { Command } from "commander";
import { profileShow, profileValidate, profileDiff } from "../commands/profile.js";
import { runExitCodeCommand } from "./shared.js";

/** Register the `profile` command group (`show`, `validate`, `diff`) on `program`. */
export function registerProfileCommands(program: Command): void {
  const profileCmd = program
    .command("profile")
    .description("Inspect the active wiki profile (read-only: show, validate, diff)");

  profileCmd
    .command("show")
    .description("Print the active profile's id, digest, and source file")
    .action(async () => {
      try {
        await profileShow();
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  profileCmd
    .command("validate")
    .description("Validate the active profile; exit non-zero with a message if invalid")
    .action(async () => runExitCodeCommand(() => profileValidate()));

  profileCmd
    .command("diff")
    .description(
      "Classify on-disk pages over the disposition lattice for an explicit old → new profile pair (read-only; writes nothing)",
    )
    .option("--candidate <file>", "Diff the active profile (old) against an uninstalled candidate file (new)")
    .option("--from <file>", "Old profile for a pure offline diff (requires --to)")
    .option("--to <file>", "New profile for a pure offline diff (requires --from)")
    .action(async (options: { candidate?: string; from?: string; to?: string }) =>
      runExitCodeCommand(() => profileDiff(options)),
    );
}
