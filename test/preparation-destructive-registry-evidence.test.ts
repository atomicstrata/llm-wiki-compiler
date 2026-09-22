/**
 * @file test/preparation-destructive-registry-evidence.test.ts
 * @description A destructive operation needs POSITIVE evidence that both
 * lifecycle registries were observable (R-9) — including when it also owns a
 * pending unit of its own.
 *
 * WHY THIS FILE EXISTS RATHER THAN ANOTHER CASE BESIDE THE OTHERS. The first
 * version of the registry-availability guard was checked on ONE arm of the
 * projection, and the existing control never built the state that separates
 * them: it constructs a faulted registry with NO pending unit, which lands on
 * the `unavailable` arm where the guard did run. A faulted registry and observed
 * pending work co-occur — one directory permission away from any crashed
 * destructive operation — and the projection can only report one of them as its
 * STATUS. The pending arm won, the guard never ran, and the operation matched
 * its own unit and deleted the bytes.
 *
 * Reproduced end to end before the fix, through the shipped service surface:
 * three objects, 7,317 bytes, irreversibly gone, over a quarantine registry that
 * could have been hiding the very `project-key-reset` unit whose custody rule is
 * the only thing forbidding that delete. Every case below therefore asserts the
 * refusal AND the bytes, because the refusal alone is satisfied by a guard that
 * blocks everything and the bytes are what was actually at stake.
 *
 * AND EVERY CASE ENDS BY REPAIRING THE FAULT, because a refusal that cannot be
 * cleared is a defect however correct it is. The unit must still be resumable
 * once the registry reads again.
 */

import { chmod, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireMutationLock, acquirePreparationMutationLock, PreparationLifecycleGateError,
  PreparationLifecycleUnobservableError,
} from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import {
  PREPARATION_PRUNE_REGISTRY, PREPARATION_QUARANTINE_SEGMENT,
} from "../src/preparations/paths.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import {
  faultableProjectRoot, symlinkRegistry, crashPruneOf as crashPruneOfShared, withUnitHidden,
} from "./preparation-destructive-fixture.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../src/preparations/reset.js";
import { perRunQuarantineUnitId } from "../src/preparations/quarantine.js";
import { crashQuarantine } from "./preparations/crash-fixture.js";
import { prunePreparationRunLocked } from "../src/preparations/retention.js";
import {
  preparationPruneUnitPaths, preparationQuarantineUnitPaths,
} from "../src/preparations/paths.js";
import { pruneUnitIdFor } from "../src/preparations/prune-delete.js";
import { cliPreparationService } from "../src/commands/preparation/host.js";
import {
  driveToFailed, LIFECYCLE_ACTOR, pruneStagedBytesThenCrashed, removePreparationKey,
  pruneStagedThenCrashed, stagePreparation, sweepStagedThenCrashed, tamperRun,
} from "./preparations/lifecycle-fixture.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";

/** The two registry directories, at module scope so every describe can seed. */
const pruneRegistryDir = (dir: string) => path.join(dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
const quarantineRegistryDir = (dir: string) => path.join(dir, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);

const AT = "2026-08-08T00:00:00.000Z";

const projectRoot = faultableProjectRoot("prep-registry-evidence-");
let root = "";
beforeEach(async () => { root = await projectRoot.make(); });
afterEach(async () => { await projectRoot.remove(root); });

/** Seed two real crashed operations, temporarily hiding the first pending unit to create the second. */
async function prunableRunBesideCrashedQuarantine(): Promise<{ runId: string; quarantineUnit: string }> {
  // Stage both before tampering: an invalid run prevents further staging.
  const prunable = await stagePreparation(root);
  const quarantined = await stagePreparation(root);
  await driveToFailed(root, prunable.binding, "2026-01-01T00:00:00.000Z");
  await tamperRun(root, quarantined.binding);
  const quarantineUnit = await crashQuarantine(root, quarantined.binding, AT);
  await withUnitHidden(quarantineRegistryDir(root), quarantineUnit,
    () => crashPruneOfShared(root, prunable.binding, AT));
  return { runId: prunable.binding.runId, quarantineUnit };
}

/** Distinguish attributed incomplete residue from a complete pending observation. */
async function expectPruneResidueObservation(complete: boolean): Promise<void> {
  const observed = await resolvePreparationLifecyclePending(root);
  expect(observed).toMatchObject({ status: "pending", unobservableRegistries: [] });
  if (observed.status === "pending") {
    expect(observed.complete).toBe(complete);
    expect(observed.problemRegistries).toEqual(complete ? [] : ["prune"]);
  }
}

/** The quarantine registry's own path, which every fault below targets. */
function quarantineRoot(): string {
  return path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
}


/** How many preparations the store still holds — what was actually at stake. */
async function manifestCount(): Promise<number> {
  return (await scanPreparationInventory(root)).manifests.length;
}

/**
 * Assert one destructive call refused on the REGISTRY evidence, and deleted
 * nothing. The two travel together: a refusal that had already deleted would
 * satisfy the first assertion alone, and the bytes are the whole point.
 */
async function expectRefusedWithNothingDeleted(
  attempt: Promise<{ status: string }>, expectedManifests: number,
): Promise<void> {
  expect(await attempt).toMatchObject({
    status: "refused", reason: expect.stringContaining("could not be read"),
  });
  expect(await manifestCount()).toBe(expectedManifests);
}

/**
 * Assert the observation is INCOMPLETE while attributing no registry.
 *
 * The precondition every unit-level case shares, and the one that proves those
 * cases exercise the completeness arm rather than re-testing the attribution
 * one. Shared because a copy that drifted would let a case silently start
 * testing the other arm.
 */
async function expectIncompleteWithNoAttribution(): Promise<void> {
  const observed = await resolvePreparationLifecyclePending(root);
  expect(observed).toMatchObject({ status: "pending", unobservableRegistries: [] });
  if (observed.status === "pending") expect(observed.complete).toBe(false);
}

/**
 * Assert the gate refused THIS destructive acquisition on the observability
 * branch specifically, by class rather than by prose.
 *
 * A refusal that arrived via run lookup, key state or generic ownership looks
 * identical at the surface and means the bypass is still live under a different
 * input. The service maps every gate refusal to the same `refused` shape, so the
 * branch is only checkable at the gate itself — which is why the acquisition is
 * taken directly here rather than through the operation.
 */
async function expectUnobservableBranch(
  intent: "prune" | "sweep" | "quarantine", targetUnitId?: string,
): Promise<void> {
  const acquisition = acquirePreparationMutationLock(
    root, intent, targetUnitId === undefined ? {} : { targetUnitId });
  await expect(acquisition).rejects.toBeInstanceOf(PreparationLifecycleUnobservableError);
}

/**
 * Assert the observation reports pending work AND names the faulted registry.
 *
 * The precondition, and it is the half that makes these cases discriminating: if
 * the fault stopped taking effect, or if it landed on the `unavailable` arm
 * instead, every refusal below would still pass while testing the state the old
 * guard already handled.
 */
async function expectPendingBesideFault(): Promise<void> {
  const observed = await resolvePreparationLifecyclePending(root);
  expect(observed.status).toBe("pending");
  if (observed.status !== "pending") return;
  expect(observed.units.length).toBeGreaterThan(0);
  expect(observed.unobservableRegistries).toContain("quarantine");
}

describe("a faulted registry refuses a destructive resume that owns its own unit", () => {
  it("refuses a crashed prune's resume while the quarantine registry is unreadable", async () => {
    const { runId } = await pruneStagedBytesThenCrashed(root, AT);
    await chmod(quarantineRoot(), 0o000);
    await expectPendingBesideFault();

    // THE BYTES, which is what the old guard let go.
    await expectRefusedWithNothingDeleted(cliPreparationService(root).prune({ runId }), 1);
    // AND FROM THE RIGHT BRANCH: a refusal from run lookup or key state would
    // satisfy the assertion above while leaving the bypass live.
    await expectUnobservableBranch("prune", pruneUnitIdFor(runId));

    // AND IT IS RECOVERABLE: repair the registry and the same resume completes.
    await chmod(quarantineRoot(), 0o700);
    expect(await cliPreparationService(root).prune({ runId }))
      .toMatchObject({ status: "pruned", resumed: true });
  });

  it("refuses it for an execute-only registry too, not just an unreadable one", async () => {
    // A SECOND FAULT SHAPE, because 0o000 and 0o100 fail at different syscalls
    // and a guard keyed to one error would pass the other straight through.
    const { runId } = await pruneStagedBytesThenCrashed(root, AT);
    await chmod(quarantineRoot(), 0o100);
    await expectPendingBesideFault();

    await expectRefusedWithNothingDeleted(cliPreparationService(root).prune({ runId }), 1);
  });

  it("refuses it for a renamed-and-symlinked registry, on the arm that route reaches", async () => {
    // THE THIRD FAULT ROUTE, and it does NOT reach the pending arm — measured,
    // not assumed. A symlinked registry ROOT fails the capture outright, so the
    // observation is `unavailable` with NO attribution and the pre-existing
    // branch refuses it. That is worth pinning precisely: this route was already
    // closed, so a probe using only this route cannot see the bypass the other
    // two routes expose. All three refuse; they do not all refuse for the same
    // reason, and a fix validated on this one alone would prove nothing about
    // the others.
    const { runId } = await pruneStagedBytesThenCrashed(root, AT);
    const hidden = path.join(root, "quarantine-hidden");
    await rename(quarantineRoot(), hidden);
    await symlink(hidden, quarantineRoot());
    expect(await resolvePreparationLifecyclePending(root))
      .toMatchObject({ status: "unavailable", registries: [] });

    await expectRefusedWithNothingDeleted(cliPreparationService(root).prune({ runId }), 1);
    await expectUnobservableBranch("prune", pruneUnitIdFor(runId));
  });

  it("refuses a crashed sweep's resume on the same evidence", async () => {
    // THE SIBLING VERB. Sweep derives its target from the registry rather than
    // from its request, so a guard that only covered prune would leave the
    // operation with MORE observation to trust running on less evidence.
    await sweepStagedThenCrashed(root, AT);
    await chmod(quarantineRoot(), 0o000);
    await expectPendingBesideFault();

    expect(await cliPreparationService(root).sweep()).toMatchObject({
      status: "refused", reason: expect.stringContaining("could not be read"),
    });

    await chmod(quarantineRoot(), 0o700);
    expect(await cliPreparationService(root).sweep())
      .toMatchObject({ status: "swept", resumed: true });
  });
});

describe("the fault hides the exact unit that forbids the delete", () => {
  /**
   * THE END-TO-END SHAPE, with a REAL pending key reset rather than a stand-in.
   *
   * Visible, the reset refuses the prune by name. Hidden behind a symlinked
   * registry root — a fault that raises no unit-level problem at all — the
   * custody rule cannot see it, because provenance comes from the unit this
   * fault conceals.
   *
   * STATED EXACTLY, because this case does not on its own demonstrate deletion:
   * recording a reset intent leaves the project key ABSENT, so a prune that got
   * past the gate would still be refused one layer down by the substrate's key
   * read. What it demonstrates is the AUTHORIZATION — the gate must refuse here,
   * on the registry evidence, rather than authorizing and relying on a key
   * failure it does not know about. The byte-level loss is the first case above,
   * where the key is healthy.
   */
  it("refuses a prune over a pending reset the fault conceals", async () => {
    const victim = await stagePreparation(root);
    await driveToFailed(root, victim.binding, "2026-01-01T00:00:00.000Z");
    await removePreparationKey(root);
    expect((await resetPreparationKeyEpochLocked(root, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
    })).status).toBe("intent-recorded");

    // VISIBLE: the custody rule names the reset.
    expect(await cliPreparationService(root).prune({ runId: victim.binding.runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("holds custody") });

    // CONCEALED: rename the registry aside and symlink over it.
    const hidden = path.join(root, "quarantine-hidden");
    await rename(quarantineRoot(), hidden);
    await symlink(hidden, quarantineRoot());

    const outcome = await cliPreparationService(root).prune({ runId: victim.binding.runId });
    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringContaining("could not be read") });
    // NOT the custody message — the gate cannot see the reset and must not
    // pretend it can. It refuses on the evidence it does have.
    expect(outcome).not.toMatchObject({ reason: expect.stringContaining("holds custody") });
    expect(await manifestCount()).toBe(1);
  });
});

describe("a faulted quarantine UNIT refuses it too, and nothing attributes a registry", () => {
  /**
   * THE OTHER AXIS, and the one the registry-attribution arm cannot see. Every
   * case above faults a registry ROOT, which attributes: the problem names no
   * unit and lands in `unobservableRegistries`. Faulting a UNIT leaves the
   * registry perfectly listable, so nothing is attributed at all — the
   * observation is merely INCOMPLETE, and only the completeness signal carries
   * it.
   *
   * It matters because provenance comes from the unit's own receipt: a
   * quarantine unit that cannot be read might BE the key reset whose custody
   * rule forbids this delete, and the rule matches by name against an operation
   * that is now `null`.
   *
   * Both cases assert `unobservableRegistries` is EMPTY, which is what proves
   * they exercise a different arm rather than re-testing the ones above.
   */
  /** Assert the state is unattributed-but-incomplete, then refuse the prune. */
  async function expectIncompleteRefusal(runId: string): Promise<void> {
    await expectIncompleteWithNoAttribution();
    expect(await cliPreparationService(root).prune({ runId })).toMatchObject({
      status: "refused", reason: expect.stringContaining("could not be read"),
    });
    await expectUnobservableBranch("prune", pruneUnitIdFor(runId));
    expect(await manifestCount()).toBe(2);
  }

  it("refuses when a quarantine unit directory cannot be read", async () => {
    const { runId, quarantineUnit } = await prunableRunBesideCrashedQuarantine();
    const unitRoot = preparationQuarantineUnitPaths(root, quarantineUnit).unitRoot;
    await chmod(unitRoot, 0o000);
    try {
      await expectIncompleteRefusal(runId);
    } finally {
      await chmod(unitRoot, 0o700);
    }
  });

  it("refuses when a quarantine unit has lost its planned receipt", async () => {
    const { runId, quarantineUnit } = await prunableRunBesideCrashedQuarantine();
    await rm(preparationQuarantineUnitPaths(root, quarantineUnit).plannedReceiptFile);
    await expectIncompleteRefusal(runId);
  });
});

describe("the mirror state: pending unit in ONE registry, fault in the OTHER", () => {
  /**
   * T1 — a crashed QUARANTINE unit (so the pending arm wins) beside a faulted
   * PRUNE registry. The routes above are all the other way round, and this one
   * is closed by the registry-attribution arm and by nothing else: no quarantine
   * unit has lost its provenance here, so a rule scoped to unit provenance sees
   * a perfectly healthy set. An unobservable prune registry can be concealing a
   * pending prune unit, which is why it must still refuse.
   */
  it("refuses a quarantine resume while the PRUNE registry cannot be observed", async () => {
    const { binding } = await stagePreparation(root);
    await tamperRun(root, binding);
    await crashQuarantine(root, binding, AT);
    await symlinkRegistry(root, PREPARATION_PRUNE_REGISTRY);

    const observed = await resolvePreparationLifecyclePending(root);
    expect(observed).toMatchObject({ status: "pending", unobservableRegistries: ["prune"] });

    const acquisition = acquirePreparationMutationLock(
      root, "quarantine", { targetUnitId: perRunQuarantineUnitId(binding.runId) });
    await expect(acquisition).rejects.toBeInstanceOf(PreparationLifecycleUnobservableError);
  });
});

describe("an unretirable unit in its OWN registry must not strand a legitimate resume", () => {
  /**
   * THE STRAND GUARD. A prune unit whose planned receipt is gone is residue no
   * shipped verb can retire — and it makes the observation incomplete. Refusing
   * every prune resume in that registry because of it would block legitimate
   * work forever for a fault that conceals nothing: a key reset lives in the
   * QUARANTINE registry, so a prune-confined incompleteness cannot be hiding
   * the unit that forbids this delete.
   *
   * This is the objection that kept an unscoped provenance check out of the
   * owner rule, and it applies just as hard to an unscoped completeness check.
   */
  it("afterStaged residue: prunes a resumable run beside a prune unit nothing can retire", async () => {
    // THE SEAM IS IN THE NAME because the seam is what decides the state, and a
    // label that travels without it has now caused four fixture collisions in
    // this review. `afterStaged` leaves durable staged bytes in the unit, so
    // stripping its receipt yields "contents with no authenticated plan" — a
    // RAISED problem, an INCOMPLETE observation, attributed to prune. That is
    // what makes this the negative that exercises confinement.
    //
    // The `afterPlanned` variant below is a DIFFERENT negative testing a
    // DIFFERENT property: it leaves the unit empty and inert, the observation
    // stays complete, and the observability arm is never reached at all.
    // BOTH RUNS STAGED BEFORE ANY TAMPERING: a crashed unit poisons the
    // inventory, and the second staging would refuse.
    const residue = await stagePreparation(root);
    const resumable = await stagePreparation(root);
    await driveToFailed(root, residue.binding, "2026-01-01T00:00:00.000Z");
    await driveToFailed(root, resumable.binding, "2026-01-01T00:00:00.000Z");
    const strandedUnit = await crashPruneOfShared(root, residue.binding, AT);
    // SEEDED FIRST, STRANDED SECOND. Two prune units cannot be created in
    // sequence any more -- a prune whose own target unit does not exist yet owns
    // nothing pending, so the gate refuses it. The first unit is hidden while the
    // second is created, and only then loses its receipt, which leaves exactly
    // the state this case is about.
    const resumableUnit = await withUnitHidden(
      pruneRegistryDir(root), strandedUnit,
      () => crashPruneOfShared(root, resumable.binding, AT));
    await rm(preparationPruneUnitPaths(root, strandedUnit).plannedReceiptFile);

    // THE SNAPSHOT FACTS, recorded because the outcome alone cannot tell a
    // correct non-firing from an accidental one — and measured rather than
    // assumed, which corrected what this comment first claimed. A unit crashed
    // AFTER STAGING and then stripped of its receipt holds durable contents with
    // no authenticated plan, so it DOES raise a problem and the observation is
    // incomplete: `complete: false` with the fault ATTRIBUTED to prune.
    //
    // That attribution is the entire reason the resume gets through. The
    // incompleteness is proven confined to the registry where a key reset can
    // never live, so it conceals nothing that forbids this delete. Refusing here
    // would strand a legitimate resume behind residue no shipped verb can
    // retire — and "more refusals is safer" is precisely the intuition that
    // produced the coarse version of this rule.
    //
    // (A unit crashed after PLANNING and then stripped reads `inert` with the
    // observation still complete — a different negative, and one this arm has
    // nothing to fire on at all.)
    await expectPruneResidueObservation(false);

    expect(await cliPreparationService(root).prune({ runId: resumable.binding.runId }))
      .toMatchObject({ status: "pruned", unitId: resumableUnit, resumed: true });
    expect(await manifestCount()).toBe(1);
  });

  it("afterPlanned residue: leaves the observation COMPLETE, so the arm is never reached", async () => {
    // THE THIRD NEGATIVE, and the one that corrected this branch's own premise.
    // The incompleteness arm was very nearly dropped on the claim that a lost
    // planned receipt always makes the observation incomplete. It does not: a
    // unit crashed after PLANNING holds only that receipt, so stripping it
    // leaves an empty unit that reads INERT — not even pending — and `complete`
    // stays TRUE.
    //
    // So this state never engages the observability arm at all, which is a
    // different fact from the `afterStaged` case above passing THROUGH it on
    // confinement. Both let the resume proceed; only one of them exercises the
    // rule, and a reader who cannot tell them apart will draw the wrong
    // conclusion about what is tested.
    const residue = await pruneStagedThenCrashed(root, AT);
    await rm(preparationPruneUnitPaths(root, residue.unitId).plannedReceiptFile);
    const resumable = await stagePreparation(root);
    await driveToFailed(root, resumable.binding, "2026-01-01T00:00:00.000Z");
    const resumableUnit = await crashPruneOfShared(root, resumable.binding, AT);

    await expectPruneResidueObservation(true);

    expect(await cliPreparationService(root).prune({ runId: resumable.binding.runId }))
      .toMatchObject({ status: "pruned", unitId: resumableUnit, resumed: true });
  });

  it("S2 control: the SAME shape refuses when the unknown unit is in QUARANTINE", async () => {
    // THE PAIR IS THE POINT. S1 alone is satisfied by a gate that never refuses
    // on provenance at all; this is what proves the scoping is a rule rather
    // than an omission. Same two-run shape, same legitimate resumable prune —
    // only the faulted registry differs, and a key reset can live in this one.
    const { runId, quarantineUnit } = await prunableRunBesideCrashedQuarantine();
    await rm(preparationQuarantineUnitPaths(root, quarantineUnit).plannedReceiptFile);

    expect(await cliPreparationService(root).prune({ runId }))
      .toMatchObject({ status: "refused", reason: expect.stringContaining("could not be read") });
    expect(await manifestCount()).toBe(2);
  });
});

describe("the shipped degradation for ORDINARY mutations is unchanged", () => {
  /**
   * G4 — the control that separates WIDENING the pending arm from REROUTING the
   * state to the `unavailable` arm. Both close the destructive bypass, so every
   * destructive probe passes either way; only this one tells them apart.
   *
   * The ordinary leg refuses on pendingness ALONE and consults the prune-only
   * degradation only on the `unavailable` arm. Reroute this state and a
   * genuinely pending prune unit starts hiding behind a degraded prune registry
   * — closing a destructive bypass by opening an ordinary one.
   */
  it("still refuses an ordinary mutation on a pending unit beside a prune fault", async () => {
    // THE FAULT HAS TO LEAVE THE UNIT VISIBLE, which is the fixture detail that
    // took a measurement: symlinking the registry ROOT removes the very unit the
    // case needs, so the state lands on the `unavailable` arm and the ordinary
    // leg degrades — testing the opposite of what the name says. A prune unit
    // that lost its receipt faults the observation while the registry stays
    // listable, so the pending unit and the prune-confined fault coexist.
    const residue = await stagePreparation(root);
    const other = await stagePreparation(root);
    await driveToFailed(root, residue.binding, "2026-01-01T00:00:00.000Z");
    await driveToFailed(root, other.binding, "2026-01-01T00:00:00.000Z");
    const strandedUnit = await crashPruneOfShared(root, residue.binding, AT);
    // SEEDED BEFORE STRANDING, so the second prune is created while the first
    // unit is invisible; only then does the first lose its receipt. Reversing
    // these leaves the gate refusing the second prune outright.
    await withUnitHidden(
      pruneRegistryDir(root), strandedUnit,
      () => crashPruneOfShared(root, other.binding, AT));
    await rm(preparationPruneUnitPaths(root, strandedUnit).plannedReceiptFile);
    await expectIncompleteWithNoAttribution();

    // The ordinary leg refuses on PENDINGNESS ALONE and never consults the
    // degradation rule on this arm. Rerouting the state to `unavailable` would
    // start it consulting one, and a genuinely pending prune unit would hide
    // behind the degraded registry.
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("still lets an ordinary mutation through a prune-confined fault", async () => {
    // BOTH HALVES IN ONE PLACE. R-9 diverges from D-10-15 for DESTRUCTIVE
    // intents only, and without this the refusals above would be
    // indistinguishable from a regression of the contract that says a prune
    // registry fault must not stall unrelated work.
    await stagePreparation(root);
    const registry = path.join(root, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
    const decoy = path.join(root, "prune-decoy");
    await rm(registry, { recursive: true, force: true });
    await symlink(decoy, registry);
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });
});
