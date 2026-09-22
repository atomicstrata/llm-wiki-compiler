/**
 * @file test/preparation-lifecycle-gate.test.ts
 * @description The mutation lock gate's preparation-lifecycle leg, tested from
 * the POSITIVE cases outward. A guard whose only tests are refusals is satisfied
 * by a guard that blocks everything, so the first two cases prove the states the
 * gate must LET THROUGH: a lifecycle unit that legitimately completed, and — the
 * one that matters — a project that stays usable after the gate refuses, driven
 * through the owning operation's own resume until the refused mutation succeeds.
 *
 * Every pending state here is produced by CRASHING A REAL SWEEP through the
 * production driver, not by planting a directory: a hand-forged unit would prove
 * only that the projector reads whatever the fixture wrote.
 *
 * The last group pins the boundary in BOTH directions, which one opaque
 * `unavailable` cannot express: a fault proven confined to the prune registry
 * degrades by shipped contract, while an unobservable quarantine registry — or a
 * fault that cannot be attributed at all — must refuse, because either can hide a
 * pending per-run quarantine or key reset.
 */

import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireMutationLock, PreparationLifecycleGateError,
} from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import {
  faultableProjectRoot, orphanOnePreparation, symlinkRegistry,
} from "./preparation-destructive-fixture.js";
import {
  preparationPaths, PREPARATION_PRUNE_REGISTRY, PREPARATION_QUARANTINE_SEGMENT,
} from "../src/preparations/paths.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../src/preparations/reset.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, sweepStagedThenCrashed,
} from "./preparations/lifecycle-fixture.js";

const CRASHED_AT = "2026-08-06T00:00:00.000Z";
const RESUMED_AT = "2026-08-06T00:05:00.000Z";

const projectRoot = faultableProjectRoot("prep-lifecycle-gate-");
let root = "";
beforeEach(async () => { root = await projectRoot.make(); });
afterEach(async () => { await projectRoot.remove(root); });

/**
 * Clear the pending unit the way an OPERATOR now does — through the service.
 *
 * This used to call the locked substrate directly, with a comment saying a gated
 * `sweep` acquisition would be blanket-refused because the per-unit owner rule
 * had no production caller. That is what changed: `sweep` is a service
 * operation, it takes the gate at `sweep` intent, and the gate hands it the
 * exact unit it may resume. Going through the substrate here would now prove
 * something weaker than what ships — state recoverability rather than an
 * operator-facing recovery — so these tests take the door an operator takes, and
 * the refusals below are consequently proven RECOVERABLE rather than merely
 * correct.
 */
async function resumeSweep(): Promise<void> {
  const outcome = await cliPreparationService(root).sweep();
  expect(outcome.status).toBe("swept");
}

/** Acquire and release, reporting whether the gate let an ordinary mutation through. */
async function ordinaryMutationProceeds(): Promise<boolean> {
  const acquired = await acquireMutationLock(root, "ordinary");
  if (acquired) await releaseLock(root);
  return acquired;
}

describe("mutation gate: preparation lifecycle is clean", () => {
  it("lets an ordinary mutation through on a project with no lifecycle units", async () => {
    expect(await ordinaryMutationProceeds()).toBe(true);
  });

  it("lets an ordinary mutation through once a sweep completes its unit", async () => {
    await orphanOnePreparation(root);
    await resumeSweep();
    // A settled unit is still ON DISK. The gate must read its STATE, not its
    // existence, or every project that ever swept is permanently refused.
    expect(await ordinaryMutationProceeds()).toBe(true);
  });
});

describe("mutation gate: a refused project stays recoverable", () => {
  /**
   * SCOPE OF THIS CLAIM, and it is now the strong one. The resume runs through
   * the `sweep` SERVICE operation, which takes a gated `sweep` acquisition and
   * receives the exact unit the owner rule authorized. So this proves what the
   * earlier revision could not: that an operator holding only the shipped verbs
   * can leave the refusing state. A refusal that had no exit would be a defect
   * whatever the gate's internal logic said, which is why this case comes first.
   */
  it("reopens the refused mutation once the underlying unit is cleared", async () => {
    await sweepStagedThenCrashed(root, CRASHED_AT);
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
    await resumeSweep();
    expect(await ordinaryMutationProceeds()).toBe(true);
  });

  it("leaves the recovery intent a way in while a unit is pending", async () => {
    await sweepStagedThenCrashed(root, CRASHED_AT);
    expect(await acquireMutationLock(root, "recovery")).toBe(true);
    await releaseLock(root);
  });
});

describe("mutation gate: preparation lifecycle refusals", () => {
  it("names the pending unit and releases the lock it acquired", async () => {
    const unitId = await sweepStagedThenCrashed(root, CRASHED_AT);
    await expect(acquireMutationLock(root, "ordinary")).rejects.toMatchObject({
      code: "quarantine-pending", message: expect.stringContaining(unitId),
    });
    // The lock was released on the block, so a second acquisition still reaches
    // the gate rather than reporting a busy lock nobody holds.
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("refuses the handoff intent too, which owns no lifecycle unit", async () => {
    await sweepStagedThenCrashed(root, CRASHED_AT);
    await expect(acquireMutationLock(root, "handoff"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });
});

/** Replace the prune registry with a symlink so it cannot be bound. */
async function unbindablePruneRegistry(): Promise<void> {
  await symlinkRegistry(root, PREPARATION_PRUNE_REGISTRY);
}

/** Make the quarantine registry unreadable in place. */
async function unreadableQuarantineRegistry(): Promise<void> {
  const registry = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
  await mkdir(registry, { recursive: true });
  await chmod(registry, 0o000);
}

/**
 * The two unreadable origins are NOT the same fact, and the gate must not treat
 * them as one. A prune-only fault degrades by shipped contract; an unobservable
 * quarantine registry can hide a pending per-run quarantine or key reset, so it
 * must fail closed. Collapsing them is a fail-OPEN on the quarantine case.
 */
describe("mutation gate: unreadable state is distinguished by registry", () => {
  it("PROCEEDS when only the prune registry cannot be bound", async () => {
    await stagePreparation(root);
    await unbindablePruneRegistry();
    // Assert the fault is IN EFFECT and attributed to prune ALONE, or deleting
    // this setup leaves the test green against a healthy project and it stops
    // pinning anything.
    expect(await resolvePreparationLifecyclePending(root))
      .toMatchObject({ status: "unavailable", registries: ["prune"] });
    expect(await ordinaryMutationProceeds()).toBe(true);
  });

  it("REFUSES when the quarantine registry cannot be observed", async () => {
    await stagePreparation(root);
    await unreadableQuarantineRegistry();
    expect(await resolvePreparationLifecyclePending(root))
      .toMatchObject({ status: "unavailable", registries: ["quarantine"] });
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("REFUSES an ORDINARY mutation when the fault cannot be attributed to any registry", async () => {
    await stagePreparation(root);
    // A symlinked quarantine ROOT fails the capture itself, so no snapshot exists
    // to attribute the fault. Unknown origin is not evidence of confinement.
    //
    // WHAT THIS OWNS, stated because the shorter title read as a GENERAL claim
    // about unattributable faults and is not one. It covers the ORDINARY leg's
    // `unavailable` arm and nothing else: the destructive path has its own
    // arms, with their own tests. Reading this as covering both is precisely
    // how a guard gets deleted by someone who believes it is tested elsewhere.
    //
    // AND WHAT IT INCIDENTALLY GUARDS: the empty `registries` set below is what
    // makes `degradesToPruneOnly` fail closed. Delete its `length > 0` and an
    // ordinary mutation PROCEEDS against a project whose lifecycle state could
    // not be read at all — the larger of that token's two consequences, and not
    // on the destructive path. The contract is asserted directly, for both call
    // sites, in `preparation-destructive-unattributed-evidence.test.ts`;
    // this case reaches it through a filesystem fixture, so that one is what
    // survives a change to this fixture.
    await symlinkRegistry(root, PREPARATION_QUARANTINE_SEGMENT);
    expect(await resolvePreparationLifecyclePending(root))
      .toMatchObject({ status: "unavailable", registries: [] });
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  /**
   * THE FAIL-OPEN THIS ORDERING EXISTS TO CLOSE, and it only appears when the
   * faulted registry is the one that DEGRADES. A pending unit paired with a
   * quarantine fault refuses either way, so it cannot witness the ordering; a
   * pending quarantine unit paired with a PRUNE-only fault is reported as a
   * confined prune fault under the old order, and a gate that degrades on those
   * then proceeds straight past unfinished destructive work.
   *
   * The pending unit is minted by the production reset path — an interrupted key
   * reset genuinely awaiting its operator continuation — not by planting bytes.
   */
  /**
   * An UNREADABLE UNIT IS NOT AN UNREADABLE REGISTRY, and conflating them fails
   * open on the degrading side. A unit root that cannot be read raises a
   * unit-scoped problem AND marks its registry's storage unavailable — so a
   * derivation that treats storage health as a registry fault reclassifies one
   * bad unit in the PRUNE registry as a confined prune fault, and this gate then
   * degrades straight past a crash-interrupted operation it must refuse.
   */
  it("REFUSES an unreadable UNIT rather than degrading it as a registry fault", async () => {
    const unitId = await sweepStagedThenCrashed(root, CRASHED_AT);
    const unitRoot = path.join(root, ".llmwiki", PREPARATION_PRUNE_REGISTRY, unitId);
    await chmod(unitRoot, 0o000);
    try {
      await expect(acquireMutationLock(root, "ordinary"))
        .rejects.toThrow(/maintenance is unfinished/u);
    } finally {
      await chmod(unitRoot, 0o700);
    }
  });

  it("REFUSES a pending unit that a DEGRADING sibling fault would otherwise hide", async () => {
    await stagePreparation(root);
    await removePreparationKey(root);
    const recorded = await resetPreparationKeyEpochLocked(root, {
      actor: LIFECYCLE_ACTOR, at: CRASHED_AT, confirmation: MISSING_KEY_CONFIRMATION,
    });
    expect(recorded.status).toBe("intent-recorded");
    await unbindablePruneRegistry();
    // The PENDING refusal specifically — the unavailable refusal would also throw
    // here, and asserting only the error class cannot tell the two apart.
    await expect(acquireMutationLock(root, "ordinary")).rejects.toThrow(/maintenance is unfinished/u);
  });
});
