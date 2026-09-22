/**
 * @file test/preparations/lifecycle-public-boundary-capture.test.ts
 * @description Authority is captured at the PUBLIC boundary, before the first await.
 *
 * The driver seals what reaches it, and that was not enough twice over:
 *
 * 1. the seal copied the top level, so nested authority — `binding` on the
 *    quarantine side, `continuation` on the reset side — stayed aliased to the
 *    caller's object;
 * 2. reset's public entry awaits its continuation read BEFORE reaching the
 *    driver, so everything between the call and the driver was a mutation window
 *    the driver could not see.
 *
 * External review reproduced both: mutating `binding.runId` put the mutated id in
 * the signed receipt, and changing `actor.id` right after calling reset produced a
 * receipt signed as the changed actor.
 *
 * These tests mutate the caller's object IMMEDIATELY after the call and before
 * awaiting, which is the real window — a caller does not need to be adversarial
 * to hit it, only to reuse a request object.
 */

import { gateDecision } from "./lifecycle-fixture.js";
import { pruneUnitIdFor } from "../../src/preparations/prune-delete.js";
import { describe, expect, it } from "vitest";
import type { SweepPreparationInput } from "../../src/preparations/retention.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import {
  MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked,
} from "../../src/preparations/reset.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";

const AT = "2026-08-01T04:00:00.000Z";
const root = useTempRoot();
const RESET = { at: AT, confirmation: MISSING_KEY_CONFIRMATION };

/** Pass one, returning the continuation pass two needs. */
async function pendingResetContinuation(dir: string) {
  await stagePreparation(dir);
  await removePreparationKey(dir);
  const first = await resetPreparationKeyEpochLocked(dir, { ...RESET, actor: { ...LIFECYCLE_ACTOR } });
  if (first.status !== "intent-recorded") throw new Error(`no intent: ${first.status}`);
  return { unitId: first.unitId, token: first.continuationToken };
}

describe("per-run quarantine captures its binding at the public boundary", () => {
  it("attests the run id supplied, not one mutated after the call", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    const input = {
      binding: { ...binding },
      actor: { ...LIFECYCLE_ACTOR },
      at: AT,
      confirmResidualState: true,
    };

    const pending = quarantinePreparationRunLocked(root.dir, input);
    // The window: the call has returned a promise and nothing has been awaited.
    // Without the capture this does not merely mis-sign — the operation reads the
    // mutated run id and refuses. Either outcome is the aliasing; what this pins
    // is that the caller's later mutation reaches the operation at all.
    input.binding.runId = "rn-mutated" as typeof binding.runId;
    input.actor.id = "impersonated";
    const receipt = await pending;

    expect(receipt.runId).toBe(binding.runId);
    expect(receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
  });
});

describe("project reset captures its request before the continuation read", () => {
  it("attests the actor supplied, not one mutated while the continuation is read", async () => {
    const continuation = await pendingResetContinuation(root.dir);
    const input = { ...RESET, actor: { ...LIFECYCLE_ACTOR }, continuation };
    const pending = resetPreparationKeyEpochLocked(root.dir, input);
    // This entry awaits `openContinuation` before the driver ever runs, so the
    // driver's own seal cannot close this window — only a capture here can.
    input.actor.id = "impersonated";
    input.at = "1999-01-01T00:00:00.000Z";
    const done = await pending;

    if (done.status !== "completed") throw new Error(`reset did not complete: ${done.status}`);
    expect(done.receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
    expect(done.receipt.at).toBe(AT);
  });

  it("still completes normally when the caller mutates nothing", async () => {
    // The control. Without it, both assertions above are satisfiable by a reset
    // that refused for some unrelated reason and never signed anything.
    const continuation = await pendingResetContinuation(root.dir);
    const done = await resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, actor: { ...LIFECYCLE_ACTOR }, continuation,
    });
    expect(done.status).toBe("completed");
  });
});

/**
 * Prune was the MISSING SIBLING.
 *
 * Quarantine and reset each grew a public-boundary capture after review
 * reproduced a mutation window; Task 9E routed prune through the same driver and
 * did not give it one. The driver's seal spreads the request, so `binding` and
 * `clock` stayed aliased to the caller's objects, and prune's adapter reads both
 * AFTER awaits — inside the driver's read lease.
 *
 * The consequence is the worst available for a delete: retargeting. Swap
 * `binding` immediately after the call and a DIFFERENT run's bytes are deleted
 * while the named one survives.
 */
describe("prune captures its binding and clock at the public boundary", () => {
  const pruneRoot = useTempRoot();

  it("prunes the run NAMED at the call, not one swapped in afterwards", async () => {
    const { driveToFailed, stagePreparation: stage } = await import("./lifecycle-fixture.js");
    const { prunePreparationRunLocked } = await import("../../src/preparations/retention.js");
    const { readPreparationRun } = await import("../../src/preparations/run-store.js");
    const target = await stage(pruneRoot.dir);
    const bystander = await stage(pruneRoot.dir);
    await driveToFailed(pruneRoot.dir, target.binding);
    await driveToFailed(pruneRoot.dir, bystander.binding);

    const input = {
      // A FRESH PRUNE OF THIS RUN, target DERIVED. These cases mutate the request
      // AFTER the call to prove the boundary captured it, so the authorization must
      // be one the gate would really issue: with the target omitted the gate refuses
      // outright, and the refusal under test would be it declining a decision that
      // never existed rather than the capture holding.
      authorization: gateDecision("prune", pruneUnitIdFor(target.binding.runId)),
      target: { kind: "run" as const, binding: { ...target.binding } },
      actor: { ...LIFECYCLE_ACTOR },
      at: AT,
      clock: { now: () => new Date("2026-07-01T00:00:00.000Z") },
    };
    const pending = prunePreparationRunLocked(pruneRoot.dir, input);
    // IN PLACE. Replacing `input.binding` cannot reach the driver -- its seal
    // spreads synchronously on entry, so the property reassignment lands after
    // the reference was already copied. Mutating the object the copy POINTS AT is
    // the real window, because the spread copied a reference, not a value.
    Object.assign(input.target.binding, bystander.binding);
    const receipt = await pending;

    expect(receipt.runId).toBe(target.binding.runId);
    // The bystander must still be readable; deleting it is the retargeting.
    expect((await readPreparationRun(pruneRoot.dir, bystander.binding)).status).not.toBe("absent");
  });

  it("keeps the retention refusal when the clock is changed after the call", async () => {
    const { driveToFailed, stagePreparation: stage } = await import("./lifecycle-fixture.js");
    const { prunePreparationRunLocked } = await import("../../src/preparations/retention.js");
    const { binding } = await stage(pruneRoot.dir);
    await driveToFailed(pruneRoot.dir, binding);

    // Within the 30-day floor at the moment of the call: this MUST refuse.
    const input = {
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
      target: { kind: "run" as const, binding: { ...binding } },
      actor: { ...LIFECYCLE_ACTOR },
      at: AT,
      clock: { now: () => new Date("2026-05-10T00:00:00.000Z") },
    };
    const pending = prunePreparationRunLocked(pruneRoot.dir, input);
    input.clock.now = () => new Date("2026-07-01T00:00:00.000Z");
    await expect(pending).rejects.toMatchObject({ code: "not-eligible" });
  });

  it("keeps the refusal when the caller mutates the Date the clock returned", async () => {
    // The residual my own capture left. Sampling `input.clock.now()` stored the
    // Date OBJECT, and `Object.freeze` does not freeze a Date's internal
    // timestamp -- so `setTime` on the caller's retained Date moved the sampled
    // instant after the eligibility decision was supposed to be fixed.
    //
    // Capturing the primitive milliseconds is the fix: there is nothing left to
    // mutate. A frozen wrapper around mutable state is not a capture.
    const { driveToFailed, stagePreparation: stage } = await import("./lifecycle-fixture.js");
    const { prunePreparationRunLocked } = await import("../../src/preparations/retention.js");
    const { binding } = await stage(pruneRoot.dir);
    await driveToFailed(pruneRoot.dir, binding);

    const withinFloor = new Date("2026-05-10T00:00:00.000Z");
    const input = {
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
      target: { kind: "run" as const, binding: { ...binding } },
      actor: { ...LIFECYCLE_ACTOR },
      at: AT,
      clock: { now: () => withinFloor },
    };
    const pending = prunePreparationRunLocked(pruneRoot.dir, input);
    withinFloor.setTime(new Date("2026-07-01T00:00:00.000Z").getTime());
    await expect(pending).rejects.toMatchObject({ code: "not-eligible" });
  });
});

/**
 * Sweep, the fourth sibling.
 *
 * Quarantine, reset and prune each grew a public-boundary capture after review
 * reproduced a mutation window. Sweep did not, because its public entry AWAITS the
 * key read before invoking the driver -- so the driver's synchronous seal happens
 * one await too late, and everything before it is a window the driver cannot see.
 *
 * Ordinary caller aliasing, no attacker and no excluded race: reuse a request
 * object and the signed receipt attests whoever the object names at seal time.
 */
describe("sweep captures its actor and timestamp at the public boundary", () => {
  const sweepRoot = useTempRoot();

  it("attests the actor supplied at the call, not one mutated immediately after", async () => {
    const { driveToFailed, stagePreparation: stage } = await import("./lifecycle-fixture.js");
    const { sweepPreparationOrphansLocked } = await import("../../src/preparations/retention.js");
    const { preparationPaths } = await import("../../src/preparations/paths.js");
    const { rm } = await import("node:fs/promises");
    const { binding } = await stage(sweepRoot.dir);
    await driveToFailed(sweepRoot.dir, binding);
    // Remove the run leaf so the preparation is a provably-absent-owner orphan.
    await rm(preparationPaths(sweepRoot.dir, binding.workspaceId).runFile(binding.runId), { force: true });

    // Annotated, so the literal type does not narrow `id` and forbid the very
    // mutation this test performs.
    const input: SweepPreparationInput = { actor: { ...LIFECYCLE_ACTOR }, at: AT, authorization: gateDecision("sweep")};
    const pending = sweepPreparationOrphansLocked(sweepRoot.dir, input);
    input.actor.id = "impersonated-operator";
    input.at = "1999-01-01T00:00:00.000Z";
    const outcome = await pending;

    // A SWEEP MUST HAVE HAPPENED. `nothing-to-sweep` would satisfy every
    // assertion below vacuously, and it is now a distinguishable answer rather
    // than the `null` this test had to guard against by hand.
    expect(outcome.status).toBe("swept");
    if (outcome.status !== "swept") return;
    expect(outcome.receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
    expect(outcome.receipt.at).toBe(AT);
  });
});
