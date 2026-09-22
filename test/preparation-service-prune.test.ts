/**
 * @file test/preparation-service-prune.test.ts
 * @description The `prune` service operation — the first gated DESTRUCTIVE
 * operation in the tree, and the first surface from which an operator can
 * reclaim a preparation's bytes at all. What it does NOT give back — the
 * workspace preparation slot — is measured and pinned in
 * `preparation-prune-sweep-races.test.ts` rather than claimed away here.
 *
 * THE RESUME CASE IS THE ONE THAT MATTERS and it comes first for that reason. A
 * prune deletes the run leaf before the manifest, so a crash mid-delete leaves a
 * pending unit whose run reads `absent` — measured, not assumed. Every other
 * mutation in that project is then refused by the gate until the unit is
 * finished, so if the resume needed a resolvable run there would be no way to
 * finish it and the project would be wedged by the operation meant to unwedge
 * it. The refusal rows below are all satisfied by an operation that refuses
 * everything; this one is not.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pruneUnitIdFor } from "../src/preparations/prune-delete.js";
import { preparationPaths, preparationPruneUnitPaths } from "../src/preparations/paths.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import { expectBusyLockRefusal } from "./preparation-destructive-fixture.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import {
  driveToFailed, driveToRecoveryRequired, makePreparationKeyUnreadable,
  pruneStagedBytesThenCrashed, stagePreparation, sweepStagedThenCrashed,
} from "./preparations/lifecycle-fixture.js";

/** More than thirty days before any real invocation of this suite. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";
const AT = "2026-08-08T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-service-prune-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Stage one run and drive it terminal far enough in the past to be eligible. */
async function prunableRun(): Promise<PreparationRunBinding> {
  const { binding } = await stagePreparation(root);
  await driveToFailed(root, binding, LONG_AGO);
  return binding;
}

describe("prune: the crashed unit an operator must be able to finish", () => {
  it("resumes a prune whose own run leaf it already deleted", async () => {
    const { runId, unitId } = await pruneStagedBytesThenCrashed(root, AT);
    // The precondition, asserted rather than assumed: the run is gone and the
    // unit is pending, which is the state a resume needing a binding cannot reach.
    expect(await resolvePreparationLifecyclePending(root)).toMatchObject({
      status: "pending", units: [{ operation: "run-prune", unitId }],
    });
    const outcome = await cliPreparationService(root).prune({ runId });
    expect(outcome).toMatchObject({ status: "pruned", runId, unitId, resumed: true });
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("clean");
  });

  it("leaves the project usable again after the resume", async () => {
    // A refusal that cannot be cleared is a defect however correct its logic, so
    // the recoverability is asserted end to end rather than inferred from the
    // unit going clean.
    const { runId } = await pruneStagedBytesThenCrashed(root, AT);
    expect((await cliPreparationService(root).prune({ runId })).status).toBe("pruned");
    const staged = await stagePreparation(root);
    expect(staged.binding.runId).toBeTruthy();
  });
});

describe("prune: the unit no shipped verb can retire", () => {
  /**
   * A STRAND, PINNED — reachable, honest, and without an exit.
   *
   * Design v10 §4 (F9) records the `operation: null` unit as escalate-only and
   * says the state's future home is a CLI repair family if it ever recurs in
   * practice. It recurs here: a prune that crashed mid-delete and then lost its
   * planned receipt — a partial write, a truncated leaf — classifies with no
   * recorded operation, because provenance comes from that receipt. No intent
   * owns it, so the gate refuses every mutation in the project and the only
   * operation that could finish the unit is refused along with the rest.
   *
   * FAIL-CLOSED IS STILL RIGHT and no widening belongs here: the unit's own
   * derived id matches this run, and admitting it on that basis would be reading
   * absent provenance as permission over a delete. What the refusal owes the
   * operator is the truth, so this asserts the message NAMES the unit and calls
   * for escalation rather than offering a resume that cannot work.
   *
   * THIS SLICE MAKES THE STATE OPERATOR-REACHABLE for the first time, because
   * before it nothing could start a prune at all. It is on the follow-up ledger.
   */
  it("refuses a unit whose provenance is gone, and says so rather than resuming", async () => {
    const { runId, unitId } = await pruneStagedBytesThenCrashed(root, AT);
    await rm(preparationPruneUnitPaths(root, unitId).plannedReceiptFile);
    expect(await resolvePreparationLifecyclePending(root)).toMatchObject({
      status: "pending", units: [{ operation: null, unitId }],
    });
    const outcome = await cliPreparationService(root).prune({ runId });
    expect(outcome).toMatchObject({
      status: "refused", reason: expect.stringContaining("has no recorded operation"),
    });
    expect(outcome).toMatchObject({ reason: expect.stringContaining(unitId) });
    // AND IT IS GENUINELY STUCK: sweep, the only other destructive verb, is
    // refused too, so nothing shipped retires it.
    expect(await cliPreparationService(root).sweep()).toMatchObject({ status: "refused" });
  });
});

describe("prune: reclaiming an eligible run", () => {
  it("deletes the run's bytes and reports what it reclaimed", async () => {
    const { runId } = await prunableRun();
    const outcome = await cliPreparationService(root).prune({ runId });
    expect(outcome).toMatchObject({ status: "pruned", runId, resumed: false });
    if (outcome.status !== "pruned") return;
    expect(outcome.objectCount).toBeGreaterThan(0);
    expect(outcome.bytesReclaimed).toBeGreaterThan(0);
    expect((await scanPreparationInventory(root)).manifests.length).toBe(0);
  });

  it("names the unit the EXECUTOR derived, from the same pure function", async () => {
    // Check and executor share one derivation. If the gate's ticket and the
    // substrate's unit came from two sources, this is the assertion that would
    // catch them diverging.
    const { runId } = await prunableRun();
    const outcome = await cliPreparationService(root).prune({ runId });
    expect(outcome).toMatchObject({ unitId: pruneUnitIdFor(runId) });
  });
});

describe("prune: refusals are returned answers, never throws", () => {
  it("refuses a run still inside its retention floor", async () => {
    const { binding } = await stagePreparation(root);
    await driveToFailed(root, binding, new Date().toISOString());
    expect(await cliPreparationService(root).prune({ runId: binding.runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("retention-floor") });
    // NOTHING WAS DELETED, which is the half a rejection assertion alone misses.
    expect((await scanPreparationInventory(root)).manifests.length).toBe(1);
  });

  it("refuses a run that is not terminal", async () => {
    const { binding } = await stagePreparation(root);
    expect(await cliPreparationService(root).prune({ runId: binding.runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("not-terminal") });
  });

  it("refuses a recovery-required run rather than reclaiming it", async () => {
    const { binding } = await stagePreparation(root);
    await driveToRecoveryRequired(root, binding);
    expect(await cliPreparationService(root).prune({ runId: binding.runId }))
      .toMatchObject({ status: "refused" });
    expect((await scanPreparationInventory(root)).manifests.length).toBe(1);
  });

  it("distinguishes an empty store from a missing run", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "prep-service-prune-bare-"));
    try {
      expect(await cliPreparationService(bare).prune({ runId: "prr_nothing" }))
        .toMatchObject({ status: "refused", reason: expect.stringContaining("no preparation store here") });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("refuses a project whose key cannot be read", async () => {
    await prunableRun();
    await makePreparationKeyUnreadable(root);
    expect(await cliPreparationService(root).prune({ runId: "prr_anything" }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("preparation key is unreadable") });
  });

  it("refuses a busy lock without claiming the run was ineligible", async () => {
    const { runId } = await prunableRun();
    await expectBusyLockRefusal(root, () => cliPreparationService(root).prune({ runId }), 1);
  });

  it("refuses while unfinished work this prune does not own is pending", async () => {
    const binding = await prunableRun();
    const runId = binding.runId;
    await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
    const sweepUnit = await sweepStagedThenCrashed(root, AT);
    expect(await cliPreparationService(root).prune({ runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining(sweepUnit) });
  });
});
