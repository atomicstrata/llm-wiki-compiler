/**
 * @file test/preparation-prune-sweep-races.test.ts
 * @description Task 11 fault and race cases for the destructive pair, plus the
 * gap they exist to close.
 *
 * THE CAP CASE COMES FIRST BECAUSE IT IS THE LIMIT, not the deliverable — and
 * this header said the opposite until a reviewer read it against the test
 * beneath it. `MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE` is the workspace cap and `fail`
 * reclaims nothing, so before these verbs shipped nothing could reclaim
 * anything. What the first case MEASURES is that pruning at the cap gives the
 * BYTES back and NOT the slot: the manifest goes, the emptied preparation
 * directory stays, the cap counts directories, and the eleventh staging still
 * refuses. The claim this file used to make — reclaim, then stage again — is
 * the one thing it proves false.
 *
 * THE RACES ARE ABOUT WHAT SERIALIZATION ACTUALLY BUYS. Both verbs take the
 * project lock, so two concurrent attempts must not both delete; and the loser
 * must say something TRUE about why it did nothing, because "nothing to
 * reclaim" and "someone else holds the lock" are different facts and only one
 * of them means retry.
 *
 * THE FAULT CASES ARE RUN THROUGH THE SERVICE ON THE RESUME LEG. The crash is
 * produced by the substrate — that is the only place the seams exist — but the
 * recovery is an operator action, so it goes through the verb an operator has.
 * Testing the resume at the substrate would prove the protocol resumes and say
 * nothing about whether anybody can reach it.
 */

import { gateDecision } from "./preparations/lifecycle-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireMutationLock } from "../src/operation-bundles/lock-gate.js";
import { MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE } from "../src/preparations/constants.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { preparationPaths } from "../src/preparations/paths.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { prunePreparationRunLocked } from "../src/preparations/retention.js";
import { pruneUnitIdFor } from "../src/preparations/prune-delete.js";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import {
  LIFECYCLE_ACTOR, driveToFailed, pruneStagedBytesThenCrashed, stagePreparation,
  sweepStagedThenCrashed,
} from "./preparations/lifecycle-fixture.js";

const AT = "2026-08-08T00:00:00.000Z";
/** Far enough in the past that the thirty-day floor is cleared by real time. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-prune-races-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Stage one run and drive it terminal far enough back to be prune-eligible. */
async function prunableRun(): Promise<string> {
  const { binding } = await stagePreparation(root);
  await driveToFailed(root, binding, LONG_AGO);
  return binding.runId;
}

describe("what reclamation does and does not give back", () => {
  /**
   * THE LIMIT, PINNED RATHER THAN CLAIMED — and it is the opposite of what this
   * slice set out to prove, so it is written down as a fact instead of quietly
   * left out.
   *
   * `prune` reclaims every BYTE the run owned: after it runs the destructive
   * scan enumerates zero leaves for that preparation, and its manifest is gone.
   * What survives is the preparation DIRECTORY itself, holding an empty
   * `evidence/` subdirectory — the two-phase delete stages and unlinks the exact
   * enumerated LEAVES that its signed plan attests, and a directory has no bytes
   * to attest. The workspace cap counts `preparationDirectories`, so the slot
   * stays consumed and the eleventh staging still refuses.
   *
   * Nothing here reclaims it: sweep skips a directory whose manifest is
   * unreadable, by exactly the rule that keeps it from deleting an owner it
   * cannot see. Freeing the slot needs an empty-directory reclamation inside the
   * delete protocol — a new mutation kind, permit-gated and fail-closed on a
   * non-empty directory — which belongs to that protocol's owner and its own
   * dated decision, not to a surface slice.
   *
   * This test exists so that the day it IS fixed, someone changes this
   * expectation on purpose.
   */
  it("reclaims the bytes but NOT the workspace preparation slot", async () => {
    const runIds: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE; index += 1) {
      runIds.push(await prunableRun());
    }
    // THE WALL, observed rather than assumed: the eleventh staging refuses.
    await expect(stagePreparation(root)).rejects.toThrow(/workspace-preparations/u);

    const pruned = await cliPreparationService(root).prune({ runId: runIds[0] as string });
    expect(pruned).toMatchObject({ status: "pruned" });
    if (pruned.status !== "pruned") return;
    expect(pruned.bytesReclaimed).toBeGreaterThan(0);

    const inventory = await scanPreparationInventory(root);
    // The manifest is genuinely gone — the reclamation happened...
    expect(inventory.manifests.length).toBe(MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE - 1);
    // ...and the slot is genuinely not back, because the emptied directory still
    // counts. Both halves, so neither can be read as the other.
    expect(inventory.workspacePreparations.get("research"))
      .toBe(MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE);
    await expect(stagePreparation(root)).rejects.toThrow(/workspace-preparations/u);
  });
});

describe("two destructive calls race for the same bytes", () => {
  it("lets exactly one concurrent prune of the same run delete, and the other says why", async () => {
    const runId = await prunableRun();
    const service = cliPreparationService(root);
    const [first, second] = await Promise.all([
      service.prune({ runId }), service.prune({ runId }),
    ]);
    const outcomes = [first.status, second.status].sort();
    // Either the loser found a busy lock, or it arrived after the winner and
    // found nothing left to prune. Both are honest; two deletions are not, and
    // an outcome claiming ineligibility would be a third, false, answer.
    expect(outcomes[0]).toBe("pruned");
    expect(["pruned", "refused"]).toContain(outcomes[1]);
    expect((await scanPreparationInventory(root)).manifests.length).toBe(0);
  });

  it("serializes a prune against a concurrent sweep rather than interleaving them", async () => {
    const runId = await prunableRun();
    const { binding } = await stagePreparation(root);
    await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
    const service = cliPreparationService(root);
    const [pruned, swept] = await Promise.all([service.prune({ runId }), service.sweep()]);
    // Whichever lost the lock refused; neither may have half-completed, so the
    // lifecycle registry must be clean afterwards either way.
    expect([pruned.status, swept.status]).toContain("refused");
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("clean");
  });
});

describe("a crash at each durable seam is recoverable through the operator's own verb", () => {
  it("resumes a prune crashed after its plan became durable", async () => {
    const { binding } = await stagePreparation(root);
    await driveToFailed(root, binding, LONG_AGO);
    await expect(prunePreparationRunLocked(root, {
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
            target: { kind: "run", binding }, actor: LIFECYCLE_ACTOR, at: AT,
      clock: { now: () => new Date() },
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    expect(await cliPreparationService(root).prune({ runId: binding.runId }))
      .toMatchObject({ status: "pruned", resumed: true });
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("clean");
  });

  it("resumes a prune crashed after its first object was staged", async () => {
    // The seam that destroys the run leaf, so the resume has no binding to
    // resolve. Its own suite pins the mechanism; this pins that the sequence is
    // recoverable with the verbs an operator has and leaves the gate open again.
    const { runId } = await pruneStagedBytesThenCrashed(root, AT);
    expect(await cliPreparationService(root).prune({ runId }))
      .toMatchObject({ status: "pruned", resumed: true });
    const staged = await stagePreparation(root);
    expect(staged.binding.runId).toBeTruthy();
  });

  it("clears a crashed prune before a sweep that the same registry was blocking", async () => {
    // TWO OPERATIONS, ONE REGISTRY. A crashed prune blocks sweep by design —
    // sweep must not derive a new unit over another operation's staged bytes —
    // so the chain that matters is: sweep refuses, the prune's owner finishes
    // it, sweep works. A refusal whose precondition nothing can clear would be
    // the strand class again.
    const { binding } = await stagePreparation(root);
    await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
    const { runId, unitId } = await pruneStagedBytesThenCrashed(root, AT);
    const service = cliPreparationService(root);
    expect(await service.sweep())
      .toMatchObject({ status: "refused", reason: expect.stringContaining(unitId) });
    expect((await service.prune({ runId })).status).toBe("pruned");
    expect(await service.sweep()).toMatchObject({ status: "swept" });
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("clean");
  });

  it("keeps a crashed sweep's unit resumable while refusing an unrelated mutation", async () => {
    const unitId = await sweepStagedThenCrashed(root, AT);
    // An unrelated GATED mutation is refused for as long as the unit is
    // unfinished. The acquisition is taken directly because the fixture's
    // staging helper calls the locked substrate and never passes the gate at
    // all — asserting against it would have tested the capacity check and
    // reported it as gate coverage.
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toMatchObject({ message: expect.stringContaining(unitId) });
    // ...and the owner's own resume is what lifts it.
    expect(await cliPreparationService(root).sweep())
      .toMatchObject({ status: "swept", unitId, resumed: true });
    const staged = await stagePreparation(root);
    expect(staged.binding.runId).toBeTruthy();
  });
});
