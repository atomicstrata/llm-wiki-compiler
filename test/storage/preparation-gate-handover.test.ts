/**
 * @file test/storage/preparation-gate-handover.test.ts
 * @description The recovery gate hands the command holding the lock its
 * settlement pass ONLY when nothing wrote after that pass's scan.
 *
 * `acquireMutationLockHandingOver` lets `stage` and `gate` take the store from
 * the scan the gate's settlement leg just made under the same hold, instead of
 * scanning again. That is sound only while nothing has written since. These
 * tests pin the three cases on a real store: a settlement that wrote nothing
 * hands over an inventory equal to a fresh scan under the hold; a settlement
 * that wrote (collecting a cancel residue) hands over nothing; and an intent
 * that skips settlement hands over nothing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { acquireMutationLockHandingOver } from "../../src/operation-bundles/lock-gate.js";
import { scanPreparationInventory, type PreparationInventory } from "../../src/preparations/capacity.js";
import { readPreparationCancel } from "../../src/preparations/cancellation.js";
import { releaseLock } from "../../src/utils/lock.js";
import { serviceOn, stagedProject, type RunningRunFixture } from "../preparation-recovery-fixture.js";

let fixture: RunningRunFixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });

/** The inventory fields a staging and a run lookup decide on. */
function decided(inventory: PreparationInventory) {
  return {
    activeBytes: inventory.activeBytes, activeNonterminalRuns: inventory.activeNonterminalRuns,
    problems: inventory.problems, runIds: [...inventory.runIds], preparationIds: [...inventory.preparationIds],
    manifests: inventory.manifests.map((manifest) => manifest.runId),
    workspacePreparations: [...inventory.workspacePreparations], epoch: inventory.epoch, quarantine: inventory.quarantine,
  };
}

describe("the gate hands over its preparation pass only when nothing wrote after it", () => {
  it("hands over an inventory equal to a fresh scan under the same hold when settlement wrote nothing", async () => {
    fixture = await stagedProject("handoverclean");
    const held = await acquireMutationLockHandingOver(fixture.root, "ordinary");
    try {
      expect(held.acquired).toBe(true);
      const pass = held.acquired ? held.preparationPass : null;
      expect(pass).not.toBeNull();
      expect(decided(pass!.inventory)).toEqual(decided(await scanPreparationInventory(fixture.root)));
      expect(pass!.inventory.runIds.has(fixture.binding.runId)).toBe(true);
    } finally {
      await releaseLock(fixture.root);
    }
  });

  it("hands over nothing when settlement wrote, here by collecting a cancel residue", async () => {
    fixture = await stagedProject("handoverwrote");
    const service = serviceOn(fixture.root, "sdk", ["preparation.cancel", "preparation.run"]);
    expect(await service.cancel({ runId: fixture.binding.runId })).toMatchObject({ request: "created" });
    expect(await service.fail({ runId: fixture.binding.runId })).toMatchObject({ status: "failed" });
    const advisory = () => readPreparationCancel(fixture!.root, fixture!.binding.workspaceId, fixture!.binding.runId);
    expect((await advisory()).status).toBe("present");
    const held = await acquireMutationLockHandingOver(fixture.root, "ordinary");
    await releaseLock(fixture.root);
    // The settlement really wrote: it removed the residue.
    expect((await advisory()).status).not.toBe("present");
    expect(held).toEqual({ acquired: true, preparationPass: null });
  });

  it("hands over nothing for an intent that skips settlement", async () => {
    fixture = await stagedProject("handoverattempt");
    const held = await acquireMutationLockHandingOver(fixture.root, "attempt");
    await releaseLock(fixture.root);
    expect(held).toEqual({ acquired: true, preparationPass: null });
  });
});
