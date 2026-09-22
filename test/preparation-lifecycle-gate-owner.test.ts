/**
 * @file test/preparation-lifecycle-gate-owner.test.ts
 * @description The PER-UNIT owner rule at the mutation gate (design v10 §4) —
 * the seam that lets a destructive operation resume its OWN crashed unit while
 * everything else still refuses.
 *
 * POSITIVE CASES FIRST, AND NOT AS A STYLE PREFERENCE. Every refusal assertion
 * in this file is satisfied by a gate that blocks unconditionally, which is
 * exactly what shipped before this rule existed. So the resume rows come first
 * and the refusals afterwards, and the two-registries fixture is the one that
 * decides whether the rule is real: with a pending quarantine unit AND a pending
 * prune unit at once, a rule quantified over the whole pending set matches
 * neither owner, refuses both, and strands the project permanently. That state
 * is built from real crashed operations rather than planted directories,
 * because a hand-forged unit proves only that the projector reads what the
 * fixture wrote.
 *
 * WHY THE TICKET IS ASSERTED AND NOT JUST THE ACQUISITION. "The gate let me in"
 * is a weaker fact than "the gate told me which unit I may finish": an
 * acquisition that returned the wrong ticket would still be an acquisition, and
 * the executor acting on it would delete bytes nothing authorized.
 */

import { gateDecision } from "./preparations/lifecycle-fixture.js";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireMutationLock, acquirePreparationMutationLock, PreparationLifecycleGateError,
} from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import {
  preparationPaths, preparationPruneUnitPaths, preparationQuarantineUnitPaths,
  PREPARATION_PRUNE_REGISTRY,
  PREPARATION_QUARANTINE_SEGMENT,
} from "../src/preparations/paths.js";
import { pruneUnitIdFor } from "../src/preparations/prune-delete.js";
import { symlinkRegistry, crashPruneOf as crashPruneOfShared, withUnitHidden } from "./preparation-destructive-fixture.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { crashQuarantine, resetAwaitingContinuation as seedResetContinuation } from "./preparations/crash-fixture.js";
import { prunePreparationRunLocked, sweepPreparationOrphansLocked } from "../src/preparations/retention.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../src/preparations/reset.js";
import {
  driveToFailed, LIFECYCLE_ACTOR, pruneStagedThenCrashed, removePreparationKey, stagePreparation,
  sweepStagedThenCrashed, tamperRun,
} from "./preparations/lifecycle-fixture.js";

const AT = "2026-08-08T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-gate-owner-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Acquire at a destructive intent and release, returning what the gate said. */
async function acquireDestructive(
  intent: "prune" | "sweep" | "quarantine", targetUnitId?: string,
) {
  const acquisition = await acquirePreparationMutationLock(
    root, intent, targetUnitId === undefined ? {} : { targetUnitId });
  if (acquisition.acquired) await releaseLock(root);
  return acquisition;
}

/** Crash a per-run quarantine of one ALREADY-TAMPERED run; return the unit id. */
async function crashQuarantineOf(binding: PreparationRunBinding): Promise<string> {
  return crashQuarantine(root, binding, AT);
}

/** Crash a sweep over whatever orphans the project already holds. */
async function crashSweep(): Promise<string> {
  await expect(sweepPreparationOrphansLocked(root, {
    actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep"),
    faults: { afterStaged: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
  const units = (await readdir(path.join(root, ".llmwiki", PREPARATION_PRUNE_REGISTRY)))
    .filter((entry) => entry.startsWith("swp-"));
  if (units.length !== 1) throw new Error(`expected one staged sweep unit, saw ${units.length}`);
  return units[0] as string;
}


/**
 * One crashed sweep AND one crashed prune, both pending in the prune registry.
 *
 * The shared half of the two asymmetry cases below, which differ only in WHICH
 * of the two units then loses its provenance — and that difference is the whole
 * point, so it stays at the call site rather than becoming a parameter.
 */
async function crashedSweepBesidePrune(): Promise<{ sweepUnit: string; pruneUnit: string }> {
  const orphaned = await stagePreparation(root);
  const prunable = await stagePreparation(root);
  await rm(preparationPaths(root, orphaned.binding.workspaceId).runFile(orphaned.binding.runId));
  const sweepUnit = await crashSweep();
  await driveToFailed(root, prunable.binding, "2026-01-01T00:00:00.000Z");
  // ASSEMBLED, NOT DRIVEN, and the reason is the change under test: the gate
  // refuses a fresh prune while the sweep unit is pending, and the driver now
  // re-runs that predicate over its own capture, so the direct-substrate route
  // this fixture used is closed too. The sweep unit is moved out of the registry
  // while the prune is seeded, then moved back. Nothing is forged -- both units
  // come from real crashed operations against real signed state.
  const pruneUnit = await withUnitHidden(
    path.join(root, ".llmwiki", PREPARATION_PRUNE_REGISTRY), sweepUnit,
    () => crashPruneOfShared(root, prunable.binding, AT),
  );
  return { sweepUnit, pruneUnit };
}

/** Stage, tamper and crash a quarantine in one project of its own. */
async function quarantineStagedThenCrashed(): Promise<string> {
  const { binding } = await stagePreparation(root);
  await tamperRun(root, binding);
  return crashQuarantineOf(binding);
}

/** Record a key reset intent, leaving a `project-key-reset` unit awaiting one. */
async function resetAwaitingContinuation(): Promise<void> {
  await seedResetContinuation(root, AT);
}

describe("gate owner rule: an owner resumes its own unit", () => {
  it("gives a prune the ticket for its own crashed unit", async () => {
    const { runId, unitId } = await pruneStagedThenCrashed(root, AT);
    // THE ACQUISITION NOW RETURNS THE DECISION, NOT ONLY ITS VERDICT. The ticket
    // is the answer; `intent` and `targetUnitId` are the QUESTION the gate was
    // asked, and they travel with it so the executor can re-run the same
    // predicate over its own capture instead of comparing a value it composed
    // itself. Asserted whole rather than reaching for `.ticket`, so a field
    // appearing or drifting here fails rather than passing unnoticed.
    expect(await acquireDestructive("prune", unitId)).toEqual({
      acquired: true,
      authorization: { intent: "prune", targetUnitId: unitId, ticket: { operation: "run-prune", unitId } },
    });
    // The ticket names the unit the EXECUTOR would derive from the same run id,
    // through the same pure function, so gate and executor cannot disagree.
    expect(unitId).toContain("prn-");
    expect(runId).toBeTruthy();
  });

  it("gives a sweep the ticket for its own crashed unit, derived under the lock", async () => {
    const unitId = await sweepStagedThenCrashed(root, AT);
    expect(await acquireDestructive("sweep")).toEqual({
      acquired: true,
      authorization: { intent: "sweep", targetUnitId: undefined, ticket: { operation: "orphan-sweep", unitId } },
    });
  });

  it("gives a quarantine the ticket for its own crashed unit", async () => {
    const unitId = await quarantineStagedThenCrashed();
    expect(await acquireDestructive("quarantine", unitId)).toEqual({
      acquired: true,
      authorization: { intent: "quarantine", targetUnitId: unitId, ticket: { operation: "per-run-quarantine", unitId } },
    });
  });

  it("gives a clean project a null ticket rather than refusing a fresh start", async () => {
    // The third answer. A fresh start is not contention and not a resume, and an
    // acquisition shape that could not say so would read a healthy project as busy.
    expect(await acquireDestructive("sweep")).toEqual({
      acquired: true, authorization: { intent: "sweep", targetUnitId: undefined, ticket: null },
    });
    expect(await acquireDestructive("prune", "prn-nothing-pending")).toEqual({
      acquired: true,
      authorization: { intent: "prune", targetUnitId: "prn-nothing-pending", ticket: null },
    });
  });
});

describe("gate owner rule: BOTH registries pending at once", () => {
  /**
   * THE FIXTURE THE RULE EXISTS FOR. Under a rule quantified over the whole
   * pending set, no single owner matches both units, both owners are refused,
   * and neither unit can ever be finished — the project is wedged by its own
   * guard. Each owner must resume its own while the other is still pending.
   */
  it("lets each owner resume its own unit while the sibling stays pending", async () => {
    // BOTH PREPARATIONS ARE STAGED FIRST. Staging refuses over a non-authoritative
    // inventory, and a crashed quarantine leaves exactly that — so building this
    // state one operation at a time is not possible, and discovering that is part
    // of why the state is worth a fixture rather than an argument.
    const quarantined = await stagePreparation(root);
    const orphaned = await stagePreparation(root);
    await rm(preparationPaths(root, orphaned.binding.workspaceId).runFile(orphaned.binding.runId));
    await tamperRun(root, quarantined.binding);
    const quarantineUnit = await crashQuarantineOf(quarantined.binding);
    // ASSEMBLED, NOT DRIVEN. The gate refuses a fresh sweep while the quarantine
    // unit is pending -- across registries, since the owner rule is about the
    // whole pending set -- and the driver now re-runs that predicate over its own
    // capture. So the quarantine unit is moved aside while the sweep is seeded,
    // then moved back. Both units are real crashed operations over real signed
    // state; only their visibility to one observation is staged.
    const sweepUnit = await withUnitHidden(
      path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT), quarantineUnit, crashSweep);
    expect(quarantineUnit).not.toBe(sweepUnit);

    expect(await acquireDestructive("quarantine", quarantineUnit)).toEqual({
      acquired: true,
      authorization: {
        intent: "quarantine", targetUnitId: quarantineUnit,
        ticket: { operation: "per-run-quarantine", unitId: quarantineUnit },
      },
    });
    expect(await acquireDestructive("sweep")).toEqual({
      acquired: true,
      authorization: {
        intent: "sweep", targetUnitId: undefined,
        ticket: { operation: "orphan-sweep", unitId: sweepUnit },
      },
    });
    // And the non-owning intents still refuse throughout, so the resume path is
    // not a hole in the serialization the gate exists to provide.
    await expect(acquireMutationLock(root, "ordinary"))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });
});

describe("gate owner rule: refusals", () => {
  it("refuses a prune that owns none of the pending work", async () => {
    const sweepUnit = await sweepStagedThenCrashed(root, AT);
    await expect(acquireDestructive("prune", "prn-some-other-run"))
      .rejects.toMatchObject({ message: expect.stringContaining(sweepUnit) });
  });

  it("refuses a prune whose target id matches a unit of ANOTHER operation", async () => {
    // The unit id is present and pending, so an id-only rule would admit it.
    // What refuses is the OPERATION comparison, which is the half that makes the
    // ticket a statement about who owns the work rather than about what exists.
    const sweepUnit = await sweepStagedThenCrashed(root, AT);
    await expect(acquireDestructive("prune", sweepUnit))
      .rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("refuses a destructive acquisition that names no target at all", async () => {
    // Only sweep derives its target at the gate. An intent that must supply one
    // and does not is a caller that skipped its own derivation, and admitting it
    // would let the unbound-ticket shape back in through omission.
    await expect(acquireDestructive("prune"))
      .rejects.toMatchObject({ message: expect.stringContaining("derive its target unit") });
  });

  it("refuses a sweep that tries to SUPPLY a target rather than have one derived", async () => {
    const unitId = await sweepStagedThenCrashed(root, AT);
    await expect(acquireDestructive("sweep", unitId))
      .rejects.toMatchObject({ message: expect.stringContaining("may not be supplied by a caller") });
  });
});

describe("gate owner rule: an unknown-provenance unit is never dropped from the set", () => {
  /**
   * THE PENDING ARM MUST CARRY EVERY PENDING UNIT, not only the ones whose state
   * decided the status. A projection that reported the work-pending units alone
   * would hand the owner rule a SHORTER set than the executors enumerate, and
   * the unit it drops is the one nothing owns — so a sweep with a legitimate
   * unit of its own would be authorized while a unit of unknown provenance sat
   * staged in the same registry.
   *
   * Both units are real: a crashed sweep, and a crashed prune whose planned
   * receipt was then lost, which is what makes its provenance unreadable.
   */
  it("refuses a sweep whose own unit is fine while an unknown unit shares the registry", async () => {
    const { sweepUnit, pruneUnit } = await crashedSweepBesidePrune();
    await rm(preparationPruneUnitPaths(root, pruneUnit).plannedReceiptFile);

    const pending = await resolvePreparationLifecyclePending(root);
    expect(pending).toMatchObject({ status: "pending" });
    if (pending.status !== "pending") return;
    // BOTH units are in the set the gate reads — the precondition, so this cannot
    // pass by the projection reporting something else entirely.
    expect(pending.units.map((unit) => unit.unitId).sort())
      .toEqual([pruneUnit, sweepUnit].sort());
    expect(pending.units.some((unit) => unit.operation === null)).toBe(true);

    await expect(acquireDestructive("sweep")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("lets a PRUNE past the same unknown unit, and the asymmetry is deliberate", async () => {
    // THE TWO VERBS DISAGREE ABOUT ONE REGISTRY STATE, so both halves are pinned
    // together — otherwise the next reader resolves the inconsistency by
    // "fixing" whichever side they meet first.
    //
    // Prune's target is a pure function of its request, so it acts on its own
    // unit's signed plan and an unrelated unknown unit is not evidence about it.
    // Sweep's target is derived by OBSERVING the registry, so a unit it cannot
    // classify makes that derivation untrustworthy. Blocking prune instead would
    // strand a legitimate resume behind an unrelated unit in its own registry.
    const { sweepUnit, pruneUnit } = await crashedSweepBesidePrune();
    // Make the SWEEP unit the unknown one, so the prune's own unit is intact.
    await rm(preparationPruneUnitPaths(root, sweepUnit).plannedReceiptFile);

    expect(await acquireDestructive("prune", pruneUnit)).toEqual({
      acquired: true,
      authorization: {
        intent: "prune", targetUnitId: pruneUnit,
        ticket: { operation: "run-prune", unitId: pruneUnit },
      },
    });
  });
});

describe("gate owner rule: a destructive intent needs positive evidence about BOTH registries", () => {
  /**
   * THE DIVERGENCE FROM D-10-15, PINNED AS A DECISION rather than left to fall
   * out of the code. D-10-15 has a destructive resume proceed while its SIBLING
   * registry is exhausted, on per-registry isolation. The reset-ordering rule
   * above needs positive evidence about the QUARANTINE registry — that is where
   * a `project-key-reset` unit lives, and it is the unit whose custody claim is
   * the only thing stopping a prune from deleting leaves the reset has taken.
   * Those two cannot both hold in the state D-10-15 names, and a path that
   * deletes bytes takes the fail-closed side: a classification that relaxes
   * safety may not be derived from a failed read.
   *
   * BOTH HALVES ARE ASSERTED TOGETHER, because the refusal alone would look like
   * a regression of the shipped prune-degradation contract. That contract is
   * about ORDINARY mutations, and it is unchanged.
   */
  it("refuses a sweep on a prune fault that an ordinary mutation degrades past", async () => {
    await stagePreparation(root);
    await symlinkRegistry(root, PREPARATION_PRUNE_REGISTRY);
    // The fault is IN EFFECT and attributed to prune ALONE — without this the
    // case would pass against a healthy project and pin nothing.
    expect(await resolvePreparationLifecyclePending(root))
      .toMatchObject({ status: "unavailable", registries: ["prune"] });

    await expect(acquireDestructive("sweep")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
    // ...while the shipped degradation for ordinary mutations is untouched.
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });
});

describe("gate owner rule: a pending key reset takes custody of everyone", () => {
  /**
   * RESET IS PROJECT-SCOPED, so the per-unit rule does not apply to it: its
   * receipt enumerates project scope and the leaves of every other destructive
   * unit become its custody. Serializing behind the lock does not make the
   * others independent of it, so it refuses them all — and it must do so by
   * NAME, or an operator reads "unfinished work" and goes looking for the wrong
   * command.
   */
  it("refuses a sweep while a key reset awaits its continuation", async () => {
    await resetAwaitingContinuation();
    await expect(acquireDestructive("sweep")).rejects.toMatchObject({
      message: expect.stringContaining("holds custody"),
    });
  });

  it("refuses a prune resume that would otherwise own its unit", async () => {
    // THE DISCRIMINATING CASE. This prune's own unit is pending and matches its
    // derived target exactly, so the per-unit rule alone would admit it. Only
    // the reset ordering refuses, which is what makes that clause load-bearing
    // rather than implied by the general rule.
    const { unitId } = await pruneStagedThenCrashed(root, AT);
    await removePreparationKey(root);
    const recorded = await resetPreparationKeyEpochLocked(root, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
    });
    expect(recorded.status).toBe("intent-recorded");
    await expect(acquireDestructive("prune", unitId)).rejects.toMatchObject({
      message: expect.stringContaining("holds custody"),
    });
  });
});
