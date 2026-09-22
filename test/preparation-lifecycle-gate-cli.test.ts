/**
 * @file test/preparation-lifecycle-gate-cli.test.ts
 * @description The lifecycle leg of the mutation gate as an OPERATOR meets it —
 * through `dist/cli.js`, on the two commands that already take the gate. The
 * in-process suite proves the leg; this proves it is reachable, that the message
 * an operator actually reads names the unit to finish, and that no durable run
 * appears from a refused stage.
 *
 * The narrative is deliberately positive-first and ends where it started: stage
 * succeeds, a crashed sweep makes it refuse, the unit is cleared, and the SAME
 * command succeeds again. A project that cannot leave the refusing state is the
 * defect this ordering exists to catch.
 *
 * SCOPE, and it widened. The clearing step used to run through the substrate's
 * locked sweep entry point because no destructive command took the gate, so the
 * binary proved the REFUSAL and the REOPENING but not an operator-facing resume.
 * `preparation sweep` now takes that gate with the per-unit owner rule behind it,
 * so every step of the narrative below is a shell command and the whole
 * refuse-then-recover cycle is proven where an operator meets it.
 *
 * THE STREAM MOVED, AND THE PROPOSITIONS DID NOT. These assertions read the gate
 * refusal off STDERR, because `stage`, `fail` and `gate` let it escape as a
 * throw. It is now a returned refusal rendered by each command's own reporter —
 * the `! <reason>` line every other refused verb already emits on STDOUT, with
 * the same non-zero exit and byte-identical text, unit id included. So each case
 * below is RE-POINTED at the stream the message is on, never relaxed: the
 * content assertions are unchanged, and each now also pins stderr EMPTY, which
 * the old version could not distinguish from a message written to both.
 *
 * The change is not cosmetic to the reason it was made: on stderr the reason was
 * unavailable to `--json` at all, which gave a consumer an empty envelope in the
 * one state an operator reaches while repairing a broken project. See
 * `preparation-pending-reset-envelopes.test.ts`.
 */

import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import type { CLIResult } from "./fixtures/run-cli.js";
import { listedStates, stageable } from "./preparation-cli-fixture.js";
import { sweepStagedThenCrashed } from "./preparations/lifecycle-fixture.js";

const CRASHED_AT = "2026-08-06T00:00:00.000Z";

/** A typed gate refusal names the pending unit only on stdout. */
function expectPendingUnitRefusal(result: CLIResult, unitId: string): void {
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain(unitId);
  expect(result.stderr).toBe("");
}

let cwd = "";
let planFile = "";
let seedFile = "";
beforeEach(async () => {
  ({ cwd, planFile, seedFile } = await stageable("lifecycle-gate"));
});

/** Stage through the binary, naming the plan and seed by relative path. */
async function stageViaCLI() {
  return runCLI([
    "preparation", "stage", path.basename(planFile), "--seed", path.basename(seedFile),
  ], cwd);
}

/**
 * Clear the pending unit THROUGH THE BINARY, which is now a real operator move.
 *
 * It used to call the locked substrate in-process, bypassing the gate on purpose
 * because a gated `sweep` acquisition would have been refused by the leg under
 * test. `preparation sweep` ships, so the whole sequence these tests describe —
 * a crashed unit refuses staging, the operator clears it, staging works again —
 * is now reachable end to end from a shell, and this asserts it there.
 */
async function resumeSweep(): Promise<void> {
  const swept = await runCLI(["preparation", "sweep"], cwd);
  expect(swept.code, swept.stderr).toBe(0);
}

describe("preparation CLI: the lifecycle gate through the binary", () => {
  it("stages when no lifecycle maintenance is outstanding", async () => {
    const staged = await stageViaCLI();
    expect(staged.code, staged.stderr).toBe(0);
    expect(staged.stdout).toContain("staged");
  });

  it("stages again once the unit it refused on is cleared", async () => {
    const unitId = await sweepStagedThenCrashed(cwd, CRASHED_AT);
    const refused = await stageViaCLI();
    expectPendingUnitRefusal(refused, unitId);
    await resumeSweep();
    expect((await stageViaCLI()).code).toBe(0);
  });
});

describe("preparation CLI: what a refused operator sees", () => {
  beforeEach(async () => { await sweepStagedThenCrashed(cwd, CRASHED_AT); });

  it("names the unfinished maintenance rather than a bare lock failure", async () => {
    const refused = await stageViaCLI();
    expect(refused.stdout).toContain("preparation lifecycle maintenance is unfinished");
    // STILL THE POINT OF THIS CASE: a bare lock failure is a RETRYABLE message
    // for a condition that will refuse identically until the unit is finished.
    expect(refused.stdout).not.toContain("lock is busy");
    expect(refused.stderr).toBe("");
  });

  it("mints no durable run from the refused stage", async () => {
    // `list` is a READ and is not gated, so an operator can still see exactly
    // what the refusal did — which must be nothing.
    const before = await listedStates(cwd);
    await stageViaCLI();
    expect(await listedStates(cwd)).toEqual(before);
  });
});

describe("preparation CLI: `fail` takes the same gate as `stage`", () => {
  it("refuses failing a real, failable run while maintenance is pending", async () => {
    const staged = await stageViaCLI();
    expect(staged.code, staged.stderr).toBe(0);
    const runId = (staged.stdout.match(/staged (\S+) in/) ?? [])[1] as string;
    // The run is genuinely failable FIRST — a refusal on a run that could never
    // be failed would pass without the gate ever being reached.
    const unitId = await sweepStagedThenCrashed(cwd, CRASHED_AT);
    const refused = await runCLI(["preparation", "fail", runId], cwd);
    expectPendingUnitRefusal(refused, unitId);
    await resumeSweep();
    expect((await runCLI(["preparation", "fail", runId], cwd)).code).toBe(0);
  });
});
