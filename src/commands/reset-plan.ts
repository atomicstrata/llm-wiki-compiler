/**
 * @file src/commands/reset-plan.ts
 * @description The deletion PLAN behind a scoped reset (AS-1 §4.8): exactly
 * which files each scope would destroy, enumerated without destroying anything.
 *
 * ONE ENUMERATION, SO PREVIEW AND EXECUTION CANNOT DISAGREE. §4.8 pins that the
 * preview "names every affected file before anything is destroyed", and a
 * preview computed separately from the deletion is a promise nothing keeps: the
 * two walks drift, and the file the operator was never shown is exactly the one
 * they would have objected to. Any executor must consume {@link planReset}'s
 * output rather than re-walking the tree.
 *
 * EVERY PATH IS CONFINED UNDER THE PROJECT ROOT. A scope root that resolves
 * outside it — through a symlinked `wiki/`, say — yields an `unavailable` plan
 * rather than a file list, because a reset that followed a link out of the
 * project would delete something nobody asked about.
 *
 * THE PLAN IS READ-ONLY; {@link executeReset} is the one consumer that
 * destroys, and it consumes THIS plan rather than re-walking the tree.
 * `state` keeps its existing backup-and-remove path untouched.
 */

import { readdir, lstat } from "node:fs/promises";
import { unlinkConfinedLeafDurable } from "../utils/confined-delete.js";
import path from "node:path";
import { isInsideDir, safeRealpath } from "../utils/path-confine.js";

/** The closed set of things a reset may be scoped to (§4.8). */
export type ResetScopeV1 = "state" | "wiki" | "raw" | "log" | "checkpoints" | "all";

/** Every scope, for callers that enumerate rather than hard-code. */
export const RESET_SCOPES: readonly ResetScopeV1[] = Object.freeze([
  "state", "wiki", "raw", "log", "checkpoints", "all",
]);

/**
 * Where each scope lives, relative to the project root.
 *
 * `all` is derived from the others rather than listed, so a scope added here is
 * automatically covered by `all` — a hand-maintained union is how a scope ends
 * up silently missing from the one option that claims to cover everything.
 */
const SCOPE_ROOTS: Readonly<Record<Exclude<ResetScopeV1, "all">, readonly string[]>> = Object.freeze({
  state: [path.join(".llmwiki", "state.json")],
  wiki: ["wiki"],
  raw: ["raw"],
  log: ["log.md"],
  checkpoints: [path.join(".llmwiki", "runs")],
});

/** One scope's plan: the files it would delete, or why it cannot be planned. */
export type ResetPlanV1 =
  | { readonly status: "planned"; readonly scope: ResetScopeV1; readonly files: readonly string[] }
  | { readonly status: "unavailable"; readonly scope: ResetScopeV1; readonly reason: string };

/** The roots one scope covers; `all` is the union of every other scope's. */
function rootsFor(scope: ResetScopeV1): readonly string[] {
  if (scope !== "all") return SCOPE_ROOTS[scope];
  return Object.values(SCOPE_ROOTS).flat();
}

/** Every file under `target`, depth-first, relative to `root`. */
async function filesUnder(root: string, target: string): Promise<string[]> {
  const info = await lstat(target).catch(() => null);
  if (info === null) return [];
  if (!info.isDirectory()) return [path.relative(root, target)];
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

/**
 * Enumerate exactly what `scope` would delete. Writes nothing.
 *
 * @param root - Absolute project root.
 * @param scope - The scope to plan.
 * @returns The sorted file list, or why the scope could not be planned.
 */
export async function planReset(root: string, scope: ResetScopeV1): Promise<ResetPlanV1> {
  const realRoot = (await safeRealpath(root)) ?? path.resolve(root);
  const files: string[] = [];
  for (const relative of rootsFor(scope)) {
    const target = path.join(root, relative);
    const real = await safeRealpath(target);
    // An absent target contributes nothing; a PRESENT one that resolves outside
    // the project is a confinement refusal, never a silent skip.
    if (real === null) continue;
    if (!isInsideDir(real, realRoot)) {
      return { status: "unavailable", scope, reason: `${relative} resolves outside the project root` };
    }
    files.push(...await filesUnder(root, real));
  }
  return { status: "planned", scope, files: [...new Set(files)].sort() };
}

/** What one executed reset did, or why it refused. */
export type ResetExecutionV1 =
  | { readonly status: "deleted"; readonly scope: ResetScopeV1; readonly deleted: readonly string[] }
  | { readonly status: "refused"; readonly scope: ResetScopeV1; readonly reason: string };

/**
 * Delete exactly what {@link planReset} named, and nothing else.
 *
 * THE PLAN IS A PARAMETER, NOT SOMETHING THIS RECOMPUTES. §4.8 pins that the
 * preview names every affected file before anything is destroyed, and that
 * promise only holds if the executor consumes the EXACT enumeration the operator
 * was shown. An earlier version re-planned here under the lock: a file created
 * between the two walks would then be deleted without ever appearing in the
 * preview, which is precisely the guarantee the docblock claimed. Taking the
 * plan as an argument makes the two impossible to diverge.
 *
 * A FILE THAT VANISHED BETWEEN PLAN AND DELETE IS FINE, and skipped silently:
 * the goal state is "not present", and something else having removed it first
 * does not make the reset a failure. A file that is present but unlinkable IS
 * reported, because then the reset did not achieve what it claims.
 *
 * DIRECTORIES ARE LEFT IN PLACE, deliberately. Removing them adds a second
 * class of destruction — one the plan never enumerated, since the plan lists
 * FILES — and an empty `wiki/` is a recoverable annoyance where a wrongly
 * removed directory is not.
 *
 * @param root - Absolute project root.
 * @param scope - The scope to destroy.
 */
export async function executeReset(
  root: string, scope: ResetScopeV1, plan: ResetPlanV1,
): Promise<ResetExecutionV1> {
  if (plan.status !== "planned") return { status: "refused", scope, reason: plan.reason };
  const deleted: string[] = [];
  for (const relative of plan.files) {
    const target = path.join(root, relative);
    try {
      if (await lstat(target).then(() => false, error => {
        if (error.code === "ENOENT") return true;
        throw error;
      })) continue;
      await unlinkConfinedLeafDurable(root, target, path.dirname(target));
      deleted.push(relative);
    } catch (error) {
      // Already gone is the goal state, reached by someone else.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { status: "refused", scope, reason: `could not delete ${relative}` };
    }
  }
  return { status: "deleted", scope, deleted };
}
