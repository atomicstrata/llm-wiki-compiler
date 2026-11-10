/**
 * @file test/storage/scoped-reset-binding.test.ts
 * @description The non-state `state reset --scope` controller as ONE body over
 * `ScopedResetSteps` (`runScopedResetWith`), none of which takes a project root,
 * against the command's root form.
 *
 * HOW IT IS BUILT. Memory steps that log every call answer the plan, the lock
 * and the executor; the printed lines are captured. They pin the scope check,
 * the unavailable-plan refusal, the dry run that never locks, and on `--yes`
 * the lock, the executor handed THE SAME plan object that was printed (no
 * re-plan), the busy and refused arms with exit code 1, the exact deleted count
 * from the executor rather than the plan, and the release. The command is then
 * shown handing the incumbent planner, lock and executor the working directory.
 *
 * NOT SHOWN HERE: planning and deletion themselves; `reset-binding` and
 * `reset-disk-calls` show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { runScopedResetWith, stateResetCommand, type ScopedResetSteps } from "../../src/commands/state-reset.js";
import * as resetPlan from "../../src/commands/reset-plan.js";
import type { ResetExecutionV1, ResetPlanV1 } from "../../src/commands/reset-plan.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as lock from "../../src/utils/lock.js";
import { captureStatusLines } from "./project-tree.js";

// Bun ignores `process.exitCode = undefined`, so "no failure recorded" is the
// explicit success code 0, reset before every run and after every test.
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

const PLAN: ResetPlanV1 = { status: "planned", scope: "wiki", files: ["wiki/a.md", "wiki/b.md"] };

/** What the memory steps answer. */
interface ResetWorld { plan?: ResetPlanV1; locked?: boolean; outcome?: ResetExecutionV1 }

/** Memory scoped-reset steps; each call logged, and the plan the executor received kept. */
function stepsOf(log: string[], world: ResetWorld = {}): ScopedResetSteps & { executed: ResetPlanV1[] } {
  const executed: ResetPlanV1[] = [];
  return {
    executed,
    plan: async (scope) => { log.push(`plan ${scope}`); return world.plan ?? PLAN; },
    acquireLock: async () => { log.push("lock"); return world.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    execute: async (scope, plan) => { log.push(`execute ${scope}`); executed.push(plan); return world.outcome ?? { status: "deleted", scope: "wiki", deleted: ["wiki/a.md"] }; },
  };
}

/** Reset `scope` over memory: printed lines, steps, exit code, and the plans executed. */
async function reset(scope: string, apply: boolean, world: ResetWorld = {}) {
  const lines: string[] = [], log: string[] = [];
  captureStatusLines(lines);
  const steps = stepsOf(log, world);
  process.exitCode = 0;
  await runScopedResetWith(steps, scope, apply);
  return { lines, log, exit: process.exitCode, executed: steps.executed };
}

describe("the scoped reset controller as a root-free body", () => {
  it("S1 an unknown scope is refused before any step; an unplannable scope is refused before any lock", async () => {
    expect(await reset("everything", true)).toMatchObject({ lines: ["! unknown scope everything; expected one of state|wiki|raw|log|checkpoints|all"], log: [], exit: 1 });
    const unavailable = await reset("wiki", true, { plan: { status: "unavailable", scope: "wiki", reason: "wiki resolves outside the project root" } });
    expect(unavailable).toMatchObject({ lines: ["! cannot plan wiki: wiki resolves outside the project root"], log: ["plan wiki"], exit: 1 });
  });

  it("S2 a dry run names every file and how to confirm, and never locks", async () => {
    expect(await reset("wiki", false)).toMatchObject({
      lines: ["→ 2 file(s) would be deleted under scope wiki:", "  wiki/a.md", "  wiki/b.md", "→ Re-run with `--yes` to delete them."], log: ["plan wiki"], exit: 0,
    });
  });

  it("S3 --yes prints the plan, then executes THAT plan under the lock and reports the executor's own count", async () => {
    const run = await reset("wiki", true);
    expect(run.log).toEqual(["plan wiki", "lock", "execute wiki", "release"]);
    expect([run.executed.length, run.executed[0] === PLAN, run.exit]).toEqual([1, true, 0]);
    expect(run.lines).toEqual(["→ 2 file(s) will be deleted under scope wiki:", "  wiki/a.md", "  wiki/b.md", "✓ Deleted 1 file(s) under scope wiki."]);
  });

  it("S4 a busy lock refuses without executing or releasing; an executor refusal exits 1 after releasing", async () => {
    const busy = await reset("wiki", true, { locked: false });
    expect([busy.log, busy.exit, busy.lines.at(-1)]).toEqual([["plan wiki", "lock"], 1, "! Another llmwiki process is using this project; not resetting."]);
    const refused = await reset("wiki", true, { outcome: { status: "refused", scope: "wiki", reason: "could not delete wiki/a.md" } });
    expect([refused.log, refused.exit, refused.lines.at(-1)]).toEqual([["plan wiki", "lock", "execute wiki", "release"], 1, "! reset refused: could not delete wiki/a.md"]);
  });
});

describe("the command's root form", () => {
  it("Z1 hands the incumbent planner, lock and executor the working directory and the printed plan", async () => {
    captureStatusLines([]);
    vi.spyOn(process, "cwd").mockReturnValue("/project");
    const plan = vi.spyOn(resetPlan, "planReset").mockResolvedValue(PLAN);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true);
    const execute = vi.spyOn(resetPlan, "executeReset").mockResolvedValue({ status: "deleted", scope: "wiki", deleted: [] });
    const release = vi.spyOn(lock, "releaseLock").mockResolvedValue(undefined);
    await stateResetCommand({ scope: "wiki", yes: true });
    expect([plan.mock.calls, acquire.mock.calls, execute.mock.calls, release.mock.calls]).toEqual([
      [["/project", "wiki"]], [["/project", "ordinary"]], [["/project", "wiki", PLAN]], [["/project"]],
    ]);
    expect(execute.mock.calls[0]?.[2]).toBe(PLAN);
  });
});
