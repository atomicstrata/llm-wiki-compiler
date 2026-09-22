/**
 * @file test/preparation-pending-reset-envelopes.test.ts
 * @description Every mutating verb answers with a PARSEABLE envelope while a
 * key reset is pending — the state an operator is in for the whole middle of the
 * stranded-key repair.
 *
 * THE STATE WAS UNREACHABLE UNTIL THE RESET SURFACE SHIPPED, which is exactly
 * why this went unnoticed. `acquireMutationLock` is a GATED acquisition: at
 * `ordinary` and `review` it refuses while any lifecycle unit is pending, and
 * that refusal was raised as a THROW. Nothing that shipped could leave a pending
 * `project-key-reset` unit, so no operator ever met the arm. Reset's pass one is
 * now the documented first step of a repair runbook and leaves precisely that
 * state.
 *
 * MEASURED, NOT INFERRED. Before the fix, through `dist/cli.js` in this state:
 * `stage`, `fail` and `gate` each returned exit 1 with **stdout empty** under
 * `--json`, the reason going to stderr as an `Error:` line. A consumer that
 * asked for a machine-readable answer got nothing at all — while diagnosing a
 * broken project, which is the worst moment to hand somebody an empty envelope.
 *
 * THE REASONING ALREADY EXISTED AND WAS APPLIED TO ONE ARM. The busy-lock arm of
 * `appendControlTransitionLocked` was already a returned refusal, on the stated
 * ground that "throwing it left `--json` with empty stdout so a consumer got no
 * envelope at all" — and the gate's refusal, raised from the same call, still
 * threw. `prune` and `sweep` classify `RecoveryGateError` at their own
 * acquisitions and carry long comments about why. This is that rule reaching the
 * verbs it had not reached.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated because a green here is not evidence
 * about it: `pause`, `resume` and `recover` refuse on their OWN state
 * preconditions before they ever acquire, so their gate arms are **not
 * exercised** by any case below. They are not shown clean; they are shown
 * unreached. Driving a run into a state where they reach the gate needs a
 * fixture this file does not build.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { emptyWorkspace, planAndSeed } from "./preparation-cli-fixture.js";
import { preparationKeyFile } from "../src/preparations/paths.js";
import { MISSING_KEY_CONFIRMATION } from "../src/preparations/reset.js";
import { removePreparationKey, stagePreparation } from "./preparations/lifecycle-fixture.js";

/** A project holding an unfinished reset AND a readable key. */
interface PendingResetProjectV1 {
  readonly cwd: string;
  readonly runId: string;
  readonly planFile: string;
  readonly seedFile: string;
}

/**
 * Leave the project with a pending `project-key-reset` unit and a WORKING key.
 *
 * THE KEY IS RESTORED ON PURPOSE, and it is what makes this fixture reach the
 * thing under test. With the key still missing, every verb below refuses on the
 * absent key long before it acquires, so the gate arm is never touched and the
 * whole file would pass without witnessing anything. Restoring the byte-identical
 * original — the operator who found their backup — leaves the pending unit as
 * the ONLY reason an acquisition can fail.
 */
async function pendingResetProject(suffix: string): Promise<PendingResetProjectV1> {
  const cwd = await emptyWorkspace(suffix);
  const { binding } = await stagePreparation(cwd);
  const { planFile, seedFile } = await planAndSeed(cwd);
  const backup = await readFile(preparationKeyFile(cwd));
  await removePreparationKey(cwd);
  const recorded = await runCLI(
    ["preparation", "reset", "--confirm", MISSING_KEY_CONFIRMATION, "--json"], cwd);
  // PIN THE PRECONDITION. If pass one did not record, there is no pending unit
  // and every case below passes for the wrong reason.
  expect(JSON.parse(recorded.stdout).status).toBe("intent-recorded");
  await writeFile(preparationKeyFile(cwd), backup, { mode: 0o600 });
  return { cwd, runId: binding.runId, planFile, seedFile };
}

/** The refusal one verb gave, insisting the envelope parse as an envelope. */
function refusalFrom(stdout: string, code: number): string {
  expect(code).toBe(1);
  // PARSING IS THE ASSERTION. An empty stdout throws here, which is the defect
  // this file exists for; a status check on an unparsed string would not see it.
  const body = JSON.parse(stdout) as { status: string; reason: string };
  expect(body.status).toBe("refused");
  return body.reason;
}

describe("a pending reset refuses in words, never in silence", () => {
  it("gives `stage` a parseable envelope naming the unfinished maintenance", async () => {
    const { cwd, planFile, seedFile } = await pendingResetProject("env-stage");
    const result = await runCLI(
      ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
    expect(refusalFrom(result.stdout, result.code)).toContain("lifecycle maintenance is unfinished");
  });

  it("gives `fail` a parseable envelope naming the unfinished maintenance", async () => {
    const { cwd, runId } = await pendingResetProject("env-fail");
    const result = await runCLI(["preparation", "fail", runId, "--json"], cwd);
    expect(refusalFrom(result.stdout, result.code)).toContain("lifecycle maintenance is unfinished");
  });

  it("gives `gate` a parseable envelope naming the unfinished maintenance", async () => {
    const { cwd, runId } = await pendingResetProject("env-gate");
    const result = await runCLI(
      ["preparation", "gate", runId, "review", "approved", "--json"], cwd);
    expect(refusalFrom(result.stdout, result.code)).toContain("lifecycle maintenance is unfinished");
  });

  it("says nothing about a busy lock, because the lock was never the reason", async () => {
    // THE COLLAPSE THIS REPLACES. Reporting the gate's refusal as "project lock
    // is busy" would tell an operator to retry something that will refuse
    // identically forever — a retryable message for a permanent condition.
    const { cwd, runId } = await pendingResetProject("env-not-busy");
    const result = await runCLI(["preparation", "fail", runId, "--json"], cwd);
    expect(refusalFrom(result.stdout, result.code)).not.toContain("busy");
  });
});

describe("the refusals are refusals, not late failures", () => {
  it("leaves the run in the state it was already in", async () => {
    // A THROW CAN BE RAISED AFTER THE WORK COMMITS, so the envelope alone is not
    // the assertion. `fail` drives a run terminal; if it had appended before
    // refusing, the run would read `failed`.
    const { cwd, runId } = await pendingResetProject("env-durable");
    await runCLI(["preparation", "fail", runId, "--json"], cwd);
    const listed = await runCLI(["preparation", "list", "--json"], cwd);
    const rows = (JSON.parse(listed.stdout) as { runs: { runId: string; state: string }[] }).runs;
    expect(rows.find((row) => row.runId === runId)?.state).toBe("planned");
  });
});
