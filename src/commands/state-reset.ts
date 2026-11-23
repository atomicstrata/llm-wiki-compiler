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
 *
 * ONE BODY EACH for the state path. {@link previewStateResetWith} (the dry run)
 * and {@link resetStateFileWith} (the confirmed reset) decide presence, the
 * escape and busy refusals, the backup-destination gate and the rename over
 * {@link StateResetSteps}. The containment decision (is `.llmwiki`'s realpath
 * inside the root's realpath?) is the body's; the two realpath observations, the
 * no-follow look, the raw rename and the lock stay the incumbent disk and host
 * mechanisms in `localStateResetSteps`. Every line the command prints is a
 * {@link StateResetNotice} reported at exactly the point it was printed before,
 * so no line moves relative to the lock.
 *
 * ONE BODY for every OTHER scope too. {@link runScopedResetWith} owns the
 * non-state controller (the scope check, the plan and its unavailable refusal,
 * the announcement, then — only with `--yes` — the lock, the executor handed the
 * PRINTED plan, its refusal and the exact deleted count, and the release) over
 * {@link ScopedResetSteps}, none of which takes a project root. The command
 * passes the local steps, which call the incumbent planner, lock and executor.
 */

import path from "path";
import { compileStateSegmented } from "../cstate/records.js";
import { renameLeafUnguarded } from "../storage/disk-guarded-leaves.js";
import { locationKindNoFollow } from "../storage/disk-local-reads.js";
import { locationExistsSync } from "../storage/disk-locations.js";
import { LLMWIKI_DIR, STATE_FILE } from "../utils/constants.js";
import { releaseLock } from "../utils/lock.js";
import { acquireMutationLock } from "../operation-bundles/lock-gate.js";
import { safeRealpath, isInsideDir, confineUnderRoot } from "../utils/path-confine.js";
import * as output from "../utils/output.js";
import {
  executeReset, planReset, RESET_SCOPES, type ResetExecutionV1, type ResetPlanV1, type ResetScopeV1,
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

/** What a scoped (non-state) reset asks of the project. No member takes a project root. */
export interface ScopedResetSteps {
  /** The deletion plan for `scope`. */
  plan(scope: ResetScopeV1): Promise<ResetPlanV1>;
  /** Take the project lock at `ordinary` intent without blocking: false when busy. */
  acquireLock(): Promise<boolean>;
  /** Release the project lock. */
  releaseLock(): Promise<void>;
  /** Delete exactly `plan`'s files; the caller holds the lock. */
  execute(scope: ResetScopeV1, plan: ResetPlanV1): Promise<ResetExecutionV1>;
}

/** LOCAL DISK. The incumbent planner, lock and executor for `root`, each called when asked. */
function localScopedResetSteps(root: string): ScopedResetSteps {
  return {
    plan: (scope) => planReset(root, scope),
    acquireLock: () => acquireMutationLock(root, "ordinary"),
    releaseLock: () => releaseLock(root),
    execute: (scope, plan) => executeReset(root, scope, plan),
  };
}

/** Validate a non-state scope, report its plan, and destroy it only on --yes: THE ONE BODY. */
export async function runScopedResetWith(steps: ScopedResetSteps, scope: string, apply: boolean): Promise<void> {
  if (!RESET_SCOPES.includes(scope as ResetScopeV1)) {
    output.status("!", output.warn(`unknown scope ${scope}; expected one of ${RESET_SCOPES.join("|")}`));
    process.exitCode = 1;
    return;
  }
  await reportScopedPlan(steps, scope as ResetScopeV1, apply);
}

/**
 * Show what a scope would destroy, then destroy it only when confirmed.
 *
 * THE PLAN IS PRINTED EVEN ON THE CONFIRMED PATH. §4.8 pins that the preview
 * names every affected file BEFORE anything is destroyed, and an operator who
 * passed `--yes` from memory still deserves the list in their scrollback when
 * they realise the scope was wrong.
 */
async function reportScopedPlan(steps: ScopedResetSteps, scope: ResetScopeV1, apply: boolean): Promise<void> {
  const plan = await steps.plan(scope);
  if (plan.status === "unavailable") {
    output.status("!", output.warn(`cannot plan ${scope}: ${plan.reason}`));
    process.exitCode = 1;
    return;
  }
  announcePlan(plan.files, scope, apply);
  // The PRINTED plan is handed to the executor: re-planning under the lock would
  // let a file created in between be deleted without ever being shown.
  if (apply) await destroyScope(steps, scope, plan);
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
async function destroyScope(steps: ScopedResetSteps, scope: ResetScopeV1, plan: ResetPlanV1): Promise<void> {
  const acquired = await steps.acquireLock();
  if (!acquired) {
    output.status("!", output.warn("Another llmwiki process is using this project; not resetting."));
    process.exitCode = 1;
    return;
  }
  try {
    const outcome = await steps.execute(scope, plan);
    if (outcome.status === "refused") {
      output.status("!", output.warn(`reset refused: ${outcome.reason}`));
      process.exitCode = 1;
      return;
    }
    // The EXACT count, from what was actually unlinked — not the plan's length,
    // which would report files that turned out to be already gone as deleted.
    output.status("✓", output.success(`Deleted ${outcome.deleted.length} file(s) under scope ${scope}.`));
  } finally {
    await steps.releaseLock();
  }
}

/** Every line the state path reports; the failures also set exit code 1. */
export type StateResetNotice = "no-state" | "plan" | "escape" | "busy" | "bak-not-regular" | "reset" | "segmented";

/** What the state reset asks of the project and its host. No member takes a project root. */
export interface StateResetSteps {
  /** The dry run's presence look at the state file (synchronous). */
  statePresent(): boolean;
  /** The real path of `.llmwiki`, or `null` when it is absent (an observation; no decision). */
  realLlmwikiDir(): Promise<string | null>;
  /** The project root's real path, or its resolved spelling when it cannot be resolved. */
  realRoot(): Promise<string>;
  /** The project lock (host). */
  acquireLock(): Promise<boolean>;
  /** Release the project lock (host). */
  releaseLock(): Promise<void>;
  /** Whether a location exists (synchronous). */
  exists(location: string): boolean;
  /** The state path confined under the project root (it need not exist). */
  confineUnderRoot(location: string): Promise<string>;
  /** A no-follow look at a location; rejects when it cannot be looked at. */
  kindNoFollow(location: string): Promise<string>;
  /** The raw rename: no parse, no validation. */
  rename(from: string, to: string): Promise<void>;
  /** Report one line, at the point the command prints it. */
  notice(code: StateResetNotice): void;
  /** OPTIONAL: whether the segmented compile state is the authority (then `state.json` is its legacy backup and is not reset). */
  segmented?(): Promise<boolean>;
}

/** The command's lines, verbatim; each failure also sets exit code 1 after its line. */
function printStateResetNotice(code: StateResetNotice): void {
  if (code === "no-state") output.status("✓", output.success("No state file to reset."));
  else if (code === "reset") output.status("✓", output.success(`Reset ${STATE_FILE}. Backup saved to ${STATE_FILE}.bak.`));
  else if (code === "plan") {
    output.status("→", `Will back up ${STATE_FILE} to ${STATE_FILE}.bak and remove it`);
    output.status("→", "so the next compile starts fresh.");
    output.status("→", output.dim("Re-run with `--yes` to confirm."));
  } else {
    if (code === "escape") output.status("!", output.warn(`${LLMWIKI_DIR} escapes the project root — refusing to reset (tampering).`));
    if (code === "busy") output.status("!", output.warn("Another llmwiki process is using this project; not resetting."));
    if (code === "segmented") output.status("!", output.warn(`the compile state is segmented (.llmwiki/indexed/cstate); ${STATE_FILE} is its untouched legacy backup, so it is not reset`));
    if (code === "bak-not-regular") {
      output.status("!", output.warn(`cannot back up: ${STATE_FILE}.bak exists and is not a regular file; remove it and retry`));
    }
    process.exitCode = 1;
  }
}

/**
 * LOCAL DISK AND HOST. The incumbent mechanisms for `root`, each called when
 * asked: the realpaths of `.llmwiki` and of the root (the observations behind the
 * journal-dir trust boundary), the existence and no-follow looks,
 * `confineUnderRoot`, the raw rename, the project lock, and the command's own
 * output.
 */
function localStateResetSteps(root: string): StateResetSteps {
  return {
    statePresent: () => locationExistsSync(path.join(root, STATE_FILE)),
    realLlmwikiDir: () => safeRealpath(path.join(root, LLMWIKI_DIR)),
    realRoot: async () => (await safeRealpath(root)) ?? path.resolve(root),
    acquireLock: () => acquireMutationLock(root, "ordinary"),
    releaseLock: () => releaseLock(root),
    exists: (location) => locationExistsSync(location),
    confineUnderRoot: (location) => confineUnderRoot(location, root, { mustExist: false }),
    kindNoFollow: (location) => locationKindNoFollow(location),
    rename: (from, to) => renameLeafUnguarded(from, to),
    notice: printStateResetNotice,
    segmented: () => compileStateSegmented(root),
  };
}

/** THE DRY-RUN BODY: no state file is the no-op line; otherwise the plan and how to confirm. Changes nothing. */
export function previewStateResetWith(steps: StateResetSteps): void {
  steps.notice(steps.statePresent() ? "plan" : "no-state");
}

/**
 * THE CONFIRMED-RESET BODY: an ABSENT `.llmwiki` is the benign no-op (the root is
 * not looked at) and one whose realpath ESCAPES the root's realpath (the
 * journal-dir trust boundary) a refusal, both before any lock; a held lock
 * refuses; otherwise the state is backed up under the lock, which is always
 * released.
 */
export async function resetStateFileWith(steps: StateResetSteps): Promise<void> {
  const realDir = await steps.realLlmwikiDir();
  if (realDir === null) return steps.notice("no-state");
  if (!isInsideDir(realDir, await steps.realRoot())) return steps.notice("escape");
  if (!(await steps.acquireLock())) return steps.notice("busy");
  try {
    if (await steps.segmented?.()) return steps.notice("segmented");
    await backupStateWith(steps, realDir);
  } finally {
    await steps.releaseLock();
  }
}

/**
 * True when the backup destination is safe to overwrite via `rename`: absent
 * (any failed look counts as absent) or a regular file (a prior backup, an
 * intended clobber). Any other kind refuses cleanly instead of a raw `EISDIR`.
 */
async function backupDestinationIsWriteableWith(steps: StateResetSteps, bakPath: string): Promise<boolean> {
  let kind: string;
  try {
    kind = await steps.kindNoFollow(bakPath);
  } catch {
    return true; // absent → safe to create
  }
  return kind === "file";
}

/**
 * Back up and remove the confined state file: the state path resolved UNDER the
 * confined `.llmwiki` dir, then the RAW bytes renamed to `state.json.bak` without
 * being read or validated, so recovery works on a too-new or corrupt state.
 */
async function backupStateWith(steps: StateResetSteps, confinedDir: string): Promise<void> {
  const statePath = path.join(confinedDir, path.basename(STATE_FILE));
  if (!steps.exists(statePath)) return steps.notice("no-state");
  const confinedState = await steps.confineUnderRoot(statePath);
  const bakPath = `${confinedState}.bak`;
  if (!(await backupDestinationIsWriteableWith(steps, bakPath))) return steps.notice("bak-not-regular");
  await steps.rename(confinedState, bakPath);
  steps.notice("reset");
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
  if (scope !== "state") return runScopedResetWith(localScopedResetSteps(root), scope, opts.yes === true);
  if (!opts.yes) {
    previewStateResetWith(localStateResetSteps(root));
    return;
  }
  await resetStateFileWith(localStateResetSteps(root));
}
