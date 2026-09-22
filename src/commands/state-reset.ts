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
 *
 * SAFETY (mirrors the journal-dir trust boundary). The reset acquires the project
 * LOCK before touching state, so it can never race a concurrent compile/writeState;
 * if the lock is held it refuses cleanly rather than forcing. It also CONFINES the
 * `.llmwiki` dir to the project root's realpath — a symlinked `.llmwiki` (or a
 * state file whose parent escapes root) fails CLOSED and nothing outside root is
 * moved or clobbered. A confinement refusal is a FAILURE (exit code 1), distinct
 * from a benign ABSENT `.llmwiki` (nothing to reset → exit 0).
 */

import { rename, realpath, lstat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { LLMWIKI_DIR, STATE_FILE } from "../utils/constants.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "../utils/path-confine.js";
import * as output from "../utils/output.js";
import {
  executeReset, planReset, RESET_SCOPES, type ResetPlanV1, type ResetScopeV1,
} from "./reset-plan.js";

/** Options for {@link stateResetCommand}. */
export interface StateResetOptions {
  /** Apply the reset. Without it, the command only prints the plan. */
  yes?: boolean;
  /**
   * What to plan (§4.8). Absent means `state` (the legacy backup-and-remove
   * path); every named scope previews its plan and, with `--yes`, deletes
   * exactly the planned files under the project lock.
   */
  scope?: string;
}

/** Validate a non-state scope, report its plan, and destroy it only on --yes. */
async function runNonStateScope(root: string, scope: string, apply: boolean): Promise<void> {
  if (!RESET_SCOPES.includes(scope as ResetScopeV1)) {
    output.status("!", output.warn(`unknown scope ${scope}; expected one of ${RESET_SCOPES.join("|")}`));
    process.exitCode = 1;
    return;
  }
  await reportScopedPlan(root, scope as ResetScopeV1, apply);
}

/**
 * Show what a scope would destroy, then destroy it only when confirmed.
 *
 * THE PLAN IS PRINTED EVEN ON THE CONFIRMED PATH. §4.8 pins that the preview
 * names every affected file BEFORE anything is destroyed, and an operator who
 * passed `--yes` from memory still deserves the list in their scrollback when
 * they realise the scope was wrong.
 */
async function reportScopedPlan(root: string, scope: ResetScopeV1, apply: boolean): Promise<void> {
  const plan = await planReset(root, scope);
  if (plan.status === "unavailable") {
    output.status("!", output.warn(`cannot plan ${scope}: ${plan.reason}`));
    process.exitCode = 1;
    return;
  }
  announcePlan(plan.files, scope, apply);
  // The PRINTED plan is handed to the executor: re-planning under the lock would
  // let a file created in between be deleted without ever being shown.
  if (apply) await destroyScope(root, scope, plan);
}

/** Name every file the scope covers, before anything is destroyed. */
function announcePlan(files: readonly string[], scope: ResetScopeV1, apply: boolean): void {
  const verb = apply ? "will be deleted" : "would be deleted";
  output.status("→", `${files.length} file(s) ${verb} under scope ${scope}:`);
  for (const file of files) output.status(" ", output.dim(file));
  if (!apply) output.status("→", output.dim("Re-run with `--yes` to delete them."));
}

/**
 * Delete a scope under the project lock, reporting exactly what went.
 *
 * THE LOCK IS TAKEN BEFORE THE DELETE, like every other mutation: a concurrent
 * compile writing pages while a reset removes them would leave a tree neither
 * one intended. A held lock REFUSES rather than waiting, and refusing is
 * non-zero so the caller never reads "reset" when nothing was reset.
 */
async function destroyScope(root: string, scope: ResetScopeV1, plan: ResetPlanV1): Promise<void> {
  const acquired = await acquireMutationLock(root, "ordinary");
  if (!acquired) {
    output.status("!", output.warn("Another llmwiki process is using this project; not resetting."));
    process.exitCode = 1;
    return;
  }
  try {
    const outcome = await executeReset(root, scope, plan);
    if (outcome.status === "refused") {
      output.status("!", output.warn(`reset refused: ${outcome.reason}`));
      process.exitCode = 1;
      return;
    }
    // The EXACT count, from what was actually unlinked — not the plan's length,
    // which would report files that turned out to be already gone as deleted.
    output.status("✓", output.success(`Deleted ${outcome.deleted.length} file(s) under scope ${scope}.`));
  } finally {
    await releaseLock(root);
  }
}

/**
 * The outcome of confining the `.llmwiki` directory under the project root:
 *  - `ok`     — a REAL in-root directory; carries the confined real `dir`.
 *  - `absent` — no `.llmwiki` directory at all (nothing to reset; a no-op success).
 *  - `escape` — `.llmwiki` exists but its realpath escapes root (filesystem
 *               tampering); a confinement REFUSAL, which must exit non-zero.
 *
 * Distinguishing `absent` from `escape` is what lets the caller exit 0 for the
 * benign no-op yet exit 1 for the tampering refusal — collapsing both to `null`
 * (the prior behavior) made a refusal masquerade as success.
 */
type LlmwikiDirResolution =
  | { kind: "ok"; dir: string }
  | { kind: "absent" }
  | { kind: "escape" };

/**
 * Resolve the confined `.llmwiki` directory for `root`, mirroring the journal-dir
 * trust boundary: its realpath must be a REAL directory that stays inside the
 * project root's realpath. Returns a tagged {@link LlmwikiDirResolution} so the
 * caller can tell a benign ABSENT dir (no-op, exit 0) apart from an ESCAPING one
 * (tampering refusal, exit non-zero). An escape is announced here.
 *
 * @param root - Absolute project root directory.
 * @returns The tagged resolution: `ok` (with the real dir), `absent`, or `escape`.
 */
async function resolveConfinedLlmwikiDir(root: string): Promise<LlmwikiDirResolution> {
  const realDir = await safeRealpath(path.join(root, LLMWIKI_DIR));
  if (realDir === null) return { kind: "absent" }; // absent → nothing to reset
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  if (!isInsideDir(realDir, realRoot)) {
    output.status("!", output.warn(`${LLMWIKI_DIR} escapes the project root — refusing to reset (tampering).`));
    return { kind: "escape" };
  }
  return { kind: "ok", dir: realDir };
}

/**
 * Dry-run path (no `--yes`): report the no-op when there is no state file, else
 * print the plan and how to confirm. Changes nothing.
 *
 * @param root - Absolute project root directory.
 */
function reportResetPlan(root: string): void {
  if (!existsSync(path.join(root, STATE_FILE))) {
    output.status("✓", output.success("No state file to reset."));
    return;
  }
  output.status("→", `Will back up ${STATE_FILE} to ${STATE_FILE}.bak and remove it`);
  output.status("→", "so the next compile starts fresh.");
  output.status("→", output.dim("Re-run with `--yes` to confirm."));
}

/**
 * Confirmed path (`--yes`): validate `.llmwiki` is a real in-root directory FIRST
 * (a read-only realpath check) so a symlinked-escaping `.llmwiki` is rejected
 * before `acquireLock` would itself create a lock file through the symlink; only
 * then acquire the lock (refusing cleanly if held), back up the raw state file,
 * and always release the lock.
 *
 * @param root - Absolute project root directory.
 */
async function runConfirmedReset(root: string): Promise<void> {
  const resolution = await resolveConfinedLlmwikiDir(root);
  if (resolution.kind === "absent") {
    output.status("✓", output.success("No state file to reset."));
    return; // benign no-op → exit 0, no lock created
  }
  if (resolution.kind === "escape") {
    process.exitCode = 1; // confinement refusal is a FAILURE
    return; // warning already announced, no lock created
  }
  const acquired = await acquireMutationLock(root, "ordinary");
  if (!acquired) {
    output.status("!", output.warn("Another llmwiki process is using this project; not resetting."));
    process.exitCode = 1; // requested reset did NOT happen → non-zero exit (no false success)
    return;
  }
  try {
    await backupStateFile(root, resolution.dir);
  } finally {
    await releaseLock(root);
  }
}

/**
 * True when the backup destination is safe to overwrite via `rename`.
 *
 * Clobbering a REGULAR-FILE `.bak` is intended (a prior backup), and an absent
 * `.bak` is fine. But a DIRECTORY `.bak` makes `rename` throw a raw, unactionable
 * `EISDIR` (→ exit 1 with `Error: EISDIR`); any other non-regular type is equally
 * unwriteable. We detect those up front with `lstat` (no symlink follow — a
 * symlink `.bak` is replaced, not written through, so it stays allowed) and
 * refuse cleanly instead. Returns false (with an actionable message emitted) when
 * the path exists and is not a regular file.
 *
 * @param bakPath - The `state.json.bak` destination path.
 * @returns True if the rename may proceed; false if it must be refused.
 */
async function backupDestinationIsWriteable(bakPath: string): Promise<boolean> {
  let st;
  try {
    st = await lstat(bakPath);
  } catch {
    return true; // absent → safe to create
  }
  if (st.isFile()) return true; // a prior backup → intended clobber
  output.status(
    "!",
    output.warn(
      `cannot back up: ${STATE_FILE}.bak exists and is not a regular file; remove it and retry`,
    ),
  );
  return false;
}

/**
 * Back up and remove the confined state file. Resolves the state path UNDER the
 * confined `.llmwiki` dir (so a symlinked parent cannot redirect the rename) and
 * renames the RAW bytes to `state.json.bak` without reading or validating them,
 * so recovery works on a too-new or corrupt state.
 *
 * Refuses CLEANLY (exit 1, no crash) when `state.json.bak` exists and is not a
 * regular file (e.g. a directory), instead of letting `rename` throw a raw
 * `EISDIR`. The state file is left untouched in that case.
 *
 * @param root - Absolute project root directory.
 * @param confinedDir - The validated `.llmwiki` real directory.
 */
async function backupStateFile(root: string, confinedDir: string): Promise<void> {
  const statePath = path.join(confinedDir, path.basename(STATE_FILE));
  if (!existsSync(statePath)) {
    output.status("✓", output.success("No state file to reset."));
    return;
  }
  const confinedState = await confineUnderRoot(statePath, root, { mustExist: false });
  const bakPath = `${confinedState}.bak`;
  if (!(await backupDestinationIsWriteable(bakPath))) {
    process.exitCode = 1; // clean actionable refusal, not a raw EISDIR crash
    return;
  }
  await rename(confinedState, bakPath);
  output.status("✓", output.success(`Reset ${STATE_FILE}. Backup saved to ${STATE_FILE}.bak.`));
}

/**
 * Back up and reset `.llmwiki/state.json`.
 *
 * - No state file → reports nothing to do and returns.
 * - Without `--yes` → prints what it would do and how to confirm; changes nothing.
 * - With `--yes` → acquires the project lock (refusing cleanly if another process
 *   holds it), validates `.llmwiki` is a real in-root directory (failing closed on
 *   a symlink escaping root), then renames the raw state file to `state.json.bak`
 *   (atomic backup + removal) without reading or validating it. Prints the backup
 *   path. The lock is always released.
 *
 * @param opts - `{ yes }` — apply the reset when true, else print the plan.
 */
export async function stateResetCommand(opts: StateResetOptions = {}): Promise<void> {
  const root = process.cwd();
  // SCOPE IS HONOURED BEFORE ANYTHING ELSE. Falling through to the state reset
  // when a caller named a different scope would destroy something they did not
  // ask about while reporting success — the worst failure this surface has.
  const scope = opts.scope ?? "state";
  if (scope !== "state") return runNonStateScope(root, scope, opts.yes === true);
  if (!opts.yes) {
    reportResetPlan(root);
    return;
  }
  await runConfirmedReset(root);
}
