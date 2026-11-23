/**
 * @file test/scale/downgrade-barrier-recovery.test.ts
 * @description The shared retirement fence on the scale-down side (IDX-1,
 * slice 1): replaying a COMPLETED bootstrapped cancel through the public
 * `cancelScaleDowngrade` reaches its stale-barrier cleanup, which must clear
 * an interrupted barrier publication of THIS plan (R alone, or R+F) whose
 * owner is positively stale, and leave another plan's group exactly as it
 * was. The completed-cancel fixture is the one
 * `downgrade-cancel-races.test.ts` uses.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * for the raw project lock; the stale owner's ESRCH is a real kernel answer.
 */

import { describe, expect, it } from "bun:test";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { barrierBytes, barrierNameState, NO_BARRIER_NAMES, plantBarrier, STALE_OWNER } from "../segments/barrier-publication-fixture.js";
import { ownPidOwnerSeamPerTest } from "../fixtures/scoped-test-roots.js";
import { plainProject, plantCompletedCancel, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

const track = trackDurableCancelProjects();
ownPidOwnerSeamPerTest();

/** A plain project holding a COMPLETED bootstrapped cancel: cancel intent, bound receipt and the retired intent. */
async function completedCancel(): Promise<CancelProject> {
  return plantCompletedCancel(track(await plainProject({ intent: false })));
}

describe("a completed cancel's replay finishes only its own interrupted barrier", () => {
  for (const state of ["R", "RF"] as const) {
    it(`clears a stale ${state} group of this plan`, async () => {
      const project = await completedCancel();
      await plantBarrier(project.root, state, barrierBytes(STALE_OWNER, { planDigest: project.plan.digest }));
      expect((await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true })).alreadyCancelled).toBe(true);
      expect(await barrierNameState(project.root)).toEqual(NO_BARRIER_NAMES);
      expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
    }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
  }

  it("keeps another plan's stale R group exactly as it was", async () => {
    const project = await completedCancel();
    await plantBarrier(project.root, "R", barrierBytes(STALE_OWNER, { planDigest: "f".repeat(64) }));
    const before = await barrierNameState(project.root);
    expect((await cancelScaleDowngrade(project.root, project.plan, { readersOffline: true })).alreadyCancelled).toBe(true);
    expect(await barrierNameState(project.root)).toEqual(before);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
