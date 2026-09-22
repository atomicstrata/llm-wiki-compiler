/**
 * @file test/preparations/lifecycle-mutation-permit.test.ts
 * @description Behavioural proof that the driver-owned mutation permit refuses.
 *
 * The structural control proves only that nothing outside a declared driver
 * IMPORTS the minting seam. That is a lexical fact; it says nothing about whether
 * the custody path actually rejects a bad permit. Without these, the permit would
 * be a control that cannot fail — which this program has shipped before and had
 * to correct.
 *
 * Scope, stated plainly: this is an accidental-bypass control inside trusted
 * code, exactly as design V2 §9.2 says. A forged permit is refused because the
 * brand is a module-private WeakSet, not because the process is adversary-proof.
 */

import { describe, expect, it } from "vitest";
import {
  assertLifecycleMutationPermit, mintLifecycleMutationPermit,
  type LifecycleMutationPermitV1,
} from "../../src/preparations/lifecycle-mutation-permit.js";
import { runTwoPhaseQuarantine } from "../../src/preparations/quarantine-move.js";
import {
  moveOldPreparationKey, publishActivePreparationKey, removeResetCrashLeaves, writeResetUnitLeaf,
} from "../../src/preparations/lifecycle-fs/reset-operations.js";
import { LIFECYCLE_ACTOR } from "./lifecycle-fixture.js";

describe("driver-owned lifecycle mutation permit", () => {
  it("accepts a driver-minted permit for its own unit", () => {
    const permit = mintLifecycleMutationPermit("quarantine", "qtn-abc");
    expect(() => assertLifecycleMutationPermit(permit, "qtn-abc")).not.toThrow();
  });

  it("refuses an absent permit", () => {
    expect(() => assertLifecycleMutationPermit(undefined, "qtn-abc"))
      .toThrow(/requires a driver-minted permit/u);
  });

  it("refuses a structurally identical permit this module did not mint", () => {
    // The whole point of the brand. An object literal with the right shape is
    // what an accidental refactor produces when it "just needs a permit here".
    const forged = Object.freeze({ operation: "quarantine", unitId: "qtn-abc" }) as LifecycleMutationPermitV1;
    expect(() => assertLifecycleMutationPermit(forged, "qtn-abc"))
      .toThrow(/requires a driver-minted permit/u);
  });

  it("refuses a genuine permit issued for a different unit", () => {
    // The failure a mis-threaded refactor actually produces: a real permit, in
    // scope, applied to the wrong unit.
    const permit = mintLifecycleMutationPermit("reset", "rst-one");
    expect(() => assertLifecycleMutationPermit(permit, "rst-two"))
      .toThrow(/issued for a different unit/u);
  });

  it("makes the custody protocol itself refuse without a permit", async () => {
    // The assertions above prove the PRIMITIVE. Measured: deleting the check from
    // runTwoPhaseQuarantine leaves every one of them green, because none of them
    // exercise the custody path. This is the one that pins the requirement.
    //
    // The permit check is the first statement, so it refuses before any
    // filesystem work — no fixture is needed and none is created.
    await expect(runTwoPhaseQuarantine({
      root: "/nonexistent", unitId: "qtn-nopermit", scope: "per-run",
      reason: "run-integrity-invalid", key: Buffer.alloc(32), keyEpochId: "0".repeat(64),
      actor: LIFECYCLE_ACTOR, at: "2026-07-31T00:00:00.000Z",
      objects: [], residualObligations: [],
    })).rejects.toThrow(/requires a driver-minted permit/u);
  });

  // One behavioural test per permit-gated mutator. Review found the same hollow
  // shape here that the custody test already fixed: the primitive was proven and
  // its USE was not. Each assertion below was verified by deleting its check.
  //
  // Every one refuses before touching the filesystem, so no fixture is needed.

  it("makes reset-key publication refuse without a permit", async () => {
    await expect(publishActivePreparationKey(
      "/nonexistent", "a".repeat(44), "rst-nopermit",
      undefined as never,
    )).rejects.toThrow(/requires a driver-minted permit/u);
  });

  it("binds reset-key publication to the PUBLISHING unit, not the permit's own id", async () => {
    // The check here read `assertLifecycleMutationPermit(permit, permit.unitId)`,
    // comparing the permit against itself — so the one mutation design V2 §9.2
    // names by name enforced only the brand and never the unit.
    const foreign = mintLifecycleMutationPermit("reset", "rst-other");
    await expect(publishActivePreparationKey(
      "/nonexistent", "a".repeat(44), "rst-publishing", foreign,
    )).rejects.toThrow(/issued for a different unit/u);
  });

  it("binds a reset-only seam to the reset operation", async () => {
    // The permit carried an `operation` and not one seam read it, so a
    // quarantine permit for the right unit opened a reset-only mutation. The
    // shared custody engine deliberately still omits this check: both
    // operations legitimately reach it.
    const wrongOperation = mintLifecycleMutationPermit("quarantine", "rst-publishing");
    await expect(publishActivePreparationKey(
      "/nonexistent", "a".repeat(44), "rst-publishing", wrongOperation,
    )).rejects.toThrow(/issued for a different operation/u);
  });

  it("makes old-key custody refuse without a permit", async () => {
    await expect(moveOldPreparationKey("/nonexistent", "rst-nopermit", undefined as never))
      .rejects.toThrow(/requires a driver-minted permit/u);
  });

  it("makes the staged-key leaf write refuse without a permit", async () => {
    await expect(writeResetUnitLeaf("/nonexistent", "rst-nopermit", "pending-key", Buffer.from("{}")))
      .rejects.toThrow(/requires a driver-minted permit/u);
  });

  // Review found the bindings proven for the PUBLISH seam only. Weakening both
  // sibling reset-only seams to brand-only left the whole suite green, so the
  // class fixed for one seam was untested on the other two.

  it("binds old-key custody to its unit and to reset", async () => {
    const foreignUnit = mintLifecycleMutationPermit("reset", "rst-other");
    await expect(moveOldPreparationKey("/nonexistent", "rst-moving", foreignUnit))
      .rejects.toThrow(/issued for a different unit/u);
    const foreignOperation = mintLifecycleMutationPermit("quarantine", "rst-moving");
    await expect(moveOldPreparationKey("/nonexistent", "rst-moving", foreignOperation))
      .rejects.toThrow(/issued for a different operation/u);
  });

  it("binds the staged-key leaf write to its unit and to reset", async () => {
    const body = Buffer.from("{}");
    const foreignUnit = mintLifecycleMutationPermit("reset", "rst-other");
    await expect(writeResetUnitLeaf("/nonexistent", "rst-staging", "pending-key", body, foreignUnit))
      .rejects.toThrow(/issued for a different unit/u);
    const foreignOperation = mintLifecycleMutationPermit("quarantine", "rst-staging");
    await expect(writeResetUnitLeaf("/nonexistent", "rst-staging", "pending-key", body, foreignOperation))
      .rejects.toThrow(/issued for a different operation/u);
  });

  it("makes crash-material removal refuse without a permit", async () => {
    // This DESTROYS crash-resumption material, and it used to run in the caller
    // after the driver returned, outside both the phase ordering and the permit
    // contract. It is now the driver's completion phase, under the same permit.
    await expect(removeResetCrashLeaves("/nonexistent", "rst-nopermit", undefined as never))
      .rejects.toThrow(/requires a driver-minted permit/u);
  });

  it("binds crash-material removal to its unit and to reset", async () => {
    const foreignUnit = mintLifecycleMutationPermit("reset", "rst-other");
    await expect(removeResetCrashLeaves("/nonexistent", "rst-clearing", foreignUnit))
      .rejects.toThrow(/issued for a different unit/u);
    const foreignOperation = mintLifecycleMutationPermit("quarantine", "rst-clearing");
    await expect(removeResetCrashLeaves("/nonexistent", "rst-clearing", foreignOperation))
      .rejects.toThrow(/issued for a different operation/u);
  });

  it("still lets pass one write its intent marker without a permit", async () => {
    // Deliberate asymmetry: pass one writes the marker before any operation
    // exists to permit, so requiring one would make pass one unreachable. This
    // pins that the exemption is exactly one leaf kind and not a general hole —
    // the refusal below is the namespace, not the permit.
    await expect(writeResetUnitLeaf("/nonexistent", "rst-intent", "intent", Buffer.from("{}")))
      .rejects.not.toThrow(/requires a driver-minted permit/u);
  });

  it("refuses a prune receipt write and a planned delete without a permit", async () => {
    // The two seams Task 9E gated. Before 9E they took no permit at all, so the
    // prune and sweep byte deletes -- the most destructive mutations in the
    // package after purge -- were reachable by any caller that imported them.
    const { writePruneReceiptBytes, deletePlannedPruneObject } =
      await import("../../src/preparations/lifecycle-fs/prune-protocol.js");
    await expect(writePruneReceiptBytes(
      undefined as never, "/nonexistent", "prn-x", "prune-planned", Buffer.from("{}"),
    )).rejects.toThrow(/requires a driver-minted permit/u);
    await expect(deletePlannedPruneObject(
      undefined as never, "/nonexistent", "prn-x", 0,
      { logicalPath: "a", byteCount: 1, digest: "d" } as never,
    )).rejects.toThrow(/requires a driver-minted permit/u);
  });

  it("refuses the destroy seam a permit minted for a DIFFERENT operation", async () => {
    // `expectedOperation` is passed only where exactly one operation is legal, and
    // the byte destroy is that seam. Mutation-tested: dropping the "purge"
    // argument left every other test green, so without this the binding was a
    // control nothing observed -- the same hollow shape review has found here
    // before, where the field authorized nothing at all.
    const { destroyQuarantineUnitBytes } =
      await import("../../src/preparations/lifecycle-fs/quarantine-operations.js");
    const wrongOperation = mintLifecycleMutationPermit("quarantine", "qtn-x");
    await expect(destroyQuarantineUnitBytes(
      wrongOperation, "/nonexistent", "qtn-x", [{ objectName: "obj-000000" }],
    )).rejects.toThrow(/issued for a different operation/u);
  });

  it("refuses each newly gated seam a permit issued for a DIFFERENT unit", async () => {
    // The unit leg was a hollow control at all three seams: making the comparison
    // vacuous left 915 tests green. The reset key seams DO have foreign-unit
    // tests; C1b/C2 copied the seam shape and only the `undefined` half of the
    // coverage -- the same hollow shape found one field over on
    // `expectedOperation`.
    //
    // This is the leg the permit module calls "a real mistake rather than a
    // theoretical one ... exactly what a mis-threaded refactor produces".
    const { writePruneReceiptBytes, deletePlannedPruneObject } =
      await import("../../src/preparations/lifecycle-fs/prune-protocol.js");
    const { destroyQuarantineUnitBytes } =
      await import("../../src/preparations/lifecycle-fs/quarantine-operations.js");
    const otherPrune = mintLifecycleMutationPermit("prune", "prn-other");
    const otherPurge = mintLifecycleMutationPermit("purge", "qtn-other");
    await expect(writePruneReceiptBytes(
      otherPrune, "/nonexistent", "prn-target", "prune-planned", Buffer.from("{}"),
    )).rejects.toThrow(/issued for a different unit/u);
    await expect(deletePlannedPruneObject(
      otherPrune, "/nonexistent", "prn-target", 0,
      { logicalPath: "a", byteCount: 1, digest: "d" } as never,
    )).rejects.toThrow(/issued for a different unit/u);
    await expect(destroyQuarantineUnitBytes(
      otherPurge, "/nonexistent", "qtn-target", [{ objectName: "obj-000000" }],
    )).rejects.toThrow(/issued for a different unit/u);
  });
});
