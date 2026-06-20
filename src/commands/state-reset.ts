/**
 * Commander action for `llmwiki state reset` — the recovery escape hatch for a
 * `.llmwiki/state.json` written by a NEWER llmwiki version.
 *
 * When a state file's schema version exceeds what this build understands, every
 * command that reads state fails closed (it never clobbers a forward-incompatible
 * layout). That is the safe default, but it leaves a user on an older pin with no
 * in-app way forward. This command provides one: back up the offending state file
 * to `state.json.bak` and remove it so the next compile starts fresh.
 *
 * Crucially, the `--yes` path NEVER parses or validates the state — it operates on
 * the raw bytes — so it works even when the state is too-new or corrupt. The backup
 * is a single atomic `rename`, which both copies and removes in one step and
 * overwrites any prior `.bak`.
 */

import { rename } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { STATE_FILE } from "../utils/constants.js";
import * as output from "../utils/output.js";

/** Options for {@link stateResetCommand}. */
export interface StateResetOptions {
  /** Apply the reset. Without it, the command only prints the plan. */
  yes?: boolean;
}

/**
 * Back up and reset `.llmwiki/state.json`.
 *
 * - No state file → reports nothing to do and returns.
 * - Without `--yes` → prints what it would do and how to confirm; changes nothing.
 * - With `--yes` → renames the raw state file to `state.json.bak` (atomic backup +
 *   removal, overwriting any prior `.bak`) without reading or validating it, so the
 *   recovery works on a too-new or corrupt state. Prints the backup path.
 */
export async function stateResetCommand(opts: StateResetOptions = {}): Promise<void> {
  const statePath = path.join(process.cwd(), STATE_FILE);
  const backupPath = `${statePath}.bak`;

  if (!existsSync(statePath)) {
    output.status("✓", output.success("No state file to reset."));
    return;
  }

  if (!opts.yes) {
    output.status("→", `Will back up ${STATE_FILE} to ${STATE_FILE}.bak and remove it`);
    output.status("→", "so the next compile starts fresh.");
    output.status("→", output.dim("Re-run with `--yes` to confirm."));
    return;
  }

  await rename(statePath, backupPath);
  output.status("✓", output.success(`Reset ${STATE_FILE}. Backup saved to ${STATE_FILE}.bak.`));
}
