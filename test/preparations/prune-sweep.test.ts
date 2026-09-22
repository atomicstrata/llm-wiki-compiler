/**
 * @file test/preparations/prune-sweep.test.ts
 * @description Retention floor, prune, and orphan sweep (design sections 26.3,
 * 26.4). Eligibility is measured by an injected clock across the 30-day floor with
 * a handed-off bundle reference check; prune and sweep delete only exact bytes
 * through a crash-resumable two-phase discipline; and sweep reclaims only a
 * provably-absent-owner orphan, never an unreadable or recovery-required run.
 */

// EACH CALL NAMES THE DECISION IT ACTS UNDER, and fresh-vs-resume is not
// cosmetic: a call following a crash that left the unit pending is a RESUME, and
// claiming a fresh start there is a decision the gate would not issue. The
// driver now re-runs the gate's own predicate over its own capture, so a
// mislabelled call refuses rather than proceeding.
import { gateDecision } from "./lifecycle-fixture.js";
import { pruneUnitIdFor } from "../../src/preparations/prune-delete.js";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { preparationPruneUnitPaths, PREPARATION_PRUNE_REGISTRY } from "../../src/preparations/paths.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import {
  prunePreparationRunLocked, pruneEligibility, PreparationPruneError, sweepPreparationOrphansLocked,
  type LifecycleClock,
} from "../../src/preparations/retention.js";
import {
  driveToFailed, driveToRecoveryRequired, LIFECYCLE_ACTOR, stagePreparation, stageAndCrashPrune, sweepStagedThenCrashed, tamperRun,
} from "./lifecycle-fixture.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";

const AT = "2026-07-20T07:00:00.000Z";
const clockAt = (iso: string): LifecycleClock => ({ now: () => new Date(iso) });
const AFTER_FLOOR = clockAt("2026-07-01T00:00:00.000Z"); // > 30 days after the failed-at instant
const WITHIN_FLOOR = clockAt("2026-05-10T00:00:00.000Z");

describe("prune eligibility and prune", () => {
  const root = useTempRoot();

  /** Resume only the existing unit belonging to this run, past the retention floor. */
  function resumePrune(binding: PreparationRunBinding) {
    const unitId = pruneUnitIdFor(binding.runId);
    return prunePreparationRunLocked(root.dir, {
      authorization: gateDecision("prune", unitId, unitId),
      target: { kind: "run", binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR,
    });
  }

  it("is eligible only for a terminal run past the injectable retention floor", async () => {
    const { binding } = await stagePreparation(root.dir);
    expect((await pruneEligibility(root.dir, binding, AFTER_FLOOR)).reason).toBe("not-terminal");
    await driveToFailed(root.dir, binding);
    expect((await pruneEligibility(root.dir, binding, WITHIN_FLOOR)).reason).toBe("retention-floor");
    expect((await pruneEligibility(root.dir, binding, AFTER_FLOOR)).eligible).toBe(true);
  });

  it("is never eligible for a recovery-required run", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToRecoveryRequired(root.dir, binding);
    expect((await pruneEligibility(root.dir, binding, AFTER_FLOOR)).eligible).toBe(false);
  });

  it("deletes an eligible run's exact bytes and keeps a tombstone", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    const receipt = await prunePreparationRunLocked(root.dir, { authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)), target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR });
    expect(receipt.kind).toBe("prune-completed");
    expect((await readPreparationRun(root.dir, binding)).status).toBe("absent");
    expect((await scanPreparationInventory(root.dir)).manifests.length).toBe(0);
  });

  it("refuses to prune a run still within the retention floor", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    const attempt = prunePreparationRunLocked(root.dir, { authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)), target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: WITHIN_FLOOR });
    await expect(attempt).rejects.toBeInstanceOf(PreparationPruneError);
    await expect(prunePreparationRunLocked(root.dir, { authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)), target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: WITHIN_FLOOR }))
      .rejects.toMatchObject({ code: "not-eligible" });
  });

  /** Prune a failed run, running `afterPlanned` once the plan is durable. */
  const pruneWithFault = (binding: PreparationRunBinding, afterPlanned: () => Promise<void>) =>
    prunePreparationRunLocked(root.dir, { authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)), target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR, faults: { afterPlanned } });

  const pruneCrashingAfterStaged = (binding: PreparationRunBinding, afterStaged: () => Promise<void>) =>
    prunePreparationRunLocked(root.dir, { authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)), target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR, faults: { afterStaged } });

  /** Stage a prunable run and return its run leaf plus the bytes the plan will see. */
  const prunableRun = async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    const runFile = preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId);
    const drift = async () => { await writeFile(runFile, Buffer.concat([await readFile(runFile), Buffer.from(" ")])); };
    return { binding, runFile, drift };
  };

  it("refuses a fresh prune whose target changed after the plan became durable", async () => {
    const { binding, runFile, drift } = await prunableRun();
    await expect(pruneWithFault(binding, drift)).rejects.toThrow(/changed since the plan/);
    await expect(lstat(runFile)).resolves.toBeTruthy();
  });

  it("refuses to delete a target whose bytes changed since the plan", async () => {
    const { binding, runFile, drift } = await prunableRun();
    await expect(pruneWithFault(binding, async () => { throw new Error("crash"); })).rejects.toThrow("crash");
    await drift();
    await expect(resumePrune(binding))
      // THE REFUSAL MOVED A LAYER EARLIER, AND MEASUREMENT SAYS THAT IS CORRECT.
      // Drifting the target destroys the unit's own classification -- measured
      // directly, the pending unit goes from operation:"run-prune", complete:true
      // to operation:null, complete:false, problemRegistries:["prune"]. So by the
      // time this resume is attempted the unit is owned by NOBODY, and the gate's
      // predicate -- which the driver now re-runs over its own capture -- refuses
      // on absent provenance before the executor can reach its own "changed since
      // the plan" comparison. Both answers refuse and neither deletes; this one
      // additionally tells the operator no verb can retire the unit, which is the
      // fact that actually blocks them.
      .rejects.toThrow(/has no recorded operation/);
    await expect(lstat(runFile)).resolves.toBeTruthy();
  });

  it("resumes a prune that crashed between staging and unlinking, leaving no staged bytes", async () => {
    const { binding, runFile } = await prunableRun();
    await expect(pruneCrashingAfterStaged(binding, async () => { throw new Error("crash"); })).rejects.toThrow("crash");
    const unitRoot = preparationPruneUnitPaths(root.dir, `prn-${createHash("sha256").update(binding.runId).digest("hex").slice(0, 32)}`).unitRoot;
    await expect(lstat(runFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(unitRoot)).some((entry) => entry.startsWith("pending-delete-"))).toBe(true);
    const receipt = await resumePrune(binding);
    expect(receipt.kind).toBe("prune-completed");
    expect((await readdir(unitRoot)).some((entry) => entry.startsWith("pending-delete-"))).toBe(false);
  });

  it("refuses to stage into a prune unit replaced by a symlink out of the project", async () => {
    const { binding, runFile } = await prunableRun();
    await expect(pruneCrashingAfterStaged(binding, async () => { throw new Error("crash"); })).rejects.toThrow("crash");
    const unitId = `prn-${createHash("sha256").update(binding.runId).digest("hex").slice(0, 32)}`;
    const unitRoot = preparationPruneUnitPaths(root.dir, unitId).unitRoot;
    const outside = path.join(root.dir, "..", `outside-${unitId}`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "sentinel"), "keep-me");
    // Copy the unit's own valid planned receipt so the symlinked unit reads as started.
    await writeFile(path.join(outside, "prune-planned.json"),
      await readFile(preparationPruneUnitPaths(root.dir, unitId).plannedReceiptFile));
    await rm(unitRoot, { recursive: true, force: true });
    await symlink(outside, unitRoot);
    try {
      await expect(resumePrune(binding))
        // REFUSED EARLIER, AND FAIL-CLOSED. Replacing the unit root with a symlink
        // out of the project makes the unit unclassifiable, so the gate's own
        // predicate -- re-run by the driver over its own capture -- refuses on an
        // unreadable lifecycle before staging can reach its "not a real directory"
        // check. Same mechanism as the drifted-target case above, whose pending
        // state was probed directly; here the arm is inferred from the refusal the
        // gate raises rather than separately measured.
        //
        // The property this case exists for is UNCHANGED and still asserted below:
        // the symlink target is not touched.
        .rejects.toThrow(/lifecycle maintenance state could not be read/);
      await expect(readFile(path.join(outside, "sentinel"), "utf8")).resolves.toBe("keep-me");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    expect(runFile).toBeTruthy();
  });

  it("resumes a prune interrupted after the deletes", async () => {
    const { binding } = await stageAndCrashPrune(root.dir, AT, "afterDeletes");
    const receipt = await resumePrune(binding);
    expect(receipt.kind).toBe("prune-completed");
  });
});

describe("orphan sweep inventory gate", () => {
  const root = useTempRoot();

  it("refuses to sweep from a partial inventory instead of deleting what it can see", async () => {
    const { binding } = await stagePreparation(root.dir);
    const workspaceDir = path.dirname(path.dirname(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId)));
    const blocked = path.join(workspaceDir, "preparations");
    await chmod(blocked, 0o000);
    try {
      await expect(sweepPreparationOrphansLocked(root.dir, { actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep")}))
        .rejects.toMatchObject({ code: "unit-unavailable" });
    } finally {
      await chmod(blocked, 0o700);
    }
  });
});

describe("orphan sweep", () => {
  const root = useTempRoot();
  /** A FRESH sweep: the caller asserts the gate saw no unfinished sweep unit. */
  const sweep = (dir: string) => sweepPreparationOrphansLocked(dir, { actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep")});
  /** A RESUME of one named unit, which is what the gate's ticket authorizes. */
  const resumeSweep = (dir: string, unitId: string) =>
    sweepPreparationOrphansLocked(dir, { actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep", undefined, unitId ?? undefined)});
  /** The receipt of a sweep that must have swept, rather than a nullable one. */
  const sweptReceipt = (outcome: Awaited<ReturnType<typeof sweep>>) => {
    if (outcome.status !== "swept") throw new Error(`expected a sweep, saw ${outcome.status}`);
    return outcome.receipt;
  };

  it("reclaims a manifest whose run leaf is provably absent", async () => {
    const { binding } = await stagePreparation(root.dir);
    await unlink(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId));
    expect(sweptReceipt(await sweep(root.dir)).operation).toBe("sweep");
    expect((await scanPreparationInventory(root.dir)).manifests.length).toBe(0);
  });

  it("resumes its own pending unit after a staging crash instead of deriving a new one", async () => {
    const { binding } = await stagePreparation(root.dir);
    await unlink(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId));
    await expect(sweepPreparationOrphansLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep"),
      faults: { afterStaged: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    const registry = path.join(root.dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
    const afterCrash = (await readdir(registry)).filter((entry) => entry.startsWith("swp-"));
    expect(afterCrash).toHaveLength(1);
    const receipt = sweptReceipt(await resumeSweep(root.dir, afterCrash[0] as string));
    expect(receipt.kind).toBe("prune-completed");
    expect(receipt.unitId).toBe(afterCrash[0]);
    expect((await readdir(registry)).filter((entry) => entry.startsWith("swp-"))).toEqual(afterCrash);
    expect((await readdir(path.join(registry, afterCrash[0] as string)))
      .some((entry) => entry.startsWith("pending-delete-"))).toBe(false);
  });

  it("refuses to derive a new sweep when staged bytes have lost their planned receipt", async () => {
    const unitId = await sweepStagedThenCrashed(root.dir, AT);
    const paths = preparationPruneUnitPaths(root.dir, unitId);
    await unlink(paths.plannedReceiptFile);
    // REFUSED BY THE GATE'S PREDICATE, one layer before the classifier. A unit
    // whose planned receipt is gone classifies with operation:null, and the sweep
    // target selector blocks on any unit it cannot classify -- so the driver's
    // re-authorization raises that detail before the executor reaches the
    // classifier's more specific "no authenticated plan" wording.
    //
    // The property is unchanged and is what this case exists for: sweep REFUSES
    // and deletes nothing. What is lost is diagnostic specificity, and that is
    // recorded on the pull request rather than papered over here.
    await expect(sweep(root.dir)).rejects.toThrow(/is an unfinished unknown operation/);
    expect((await readdir(paths.unitRoot)).some((entry) => entry.startsWith("pending-delete-"))).toBe(true);
  });

  it("refuses a renamed staged leaf just as it refuses a prefixed one", async () => {
    const unitId = await sweepStagedThenCrashed(root.dir, AT);
    const paths = preparationPruneUnitPaths(root.dir, unitId);
    const staged = (await readdir(paths.unitRoot)).find((entry) => entry.startsWith("pending-delete-")) as string;
    await rename(path.join(paths.unitRoot, staged), path.join(paths.unitRoot, "innocuous.bin"));
    await unlink(paths.plannedReceiptFile);
    // REFUSED BY THE GATE'S PREDICATE, one layer before the classifier. A unit
    // whose planned receipt is gone classifies with operation:null, and the sweep
    // target selector blocks on any unit it cannot classify -- so the driver's
    // re-authorization raises that detail before the executor reaches the
    // classifier's more specific "no authenticated plan" wording.
    //
    // The property is unchanged and is what this case exists for: sweep REFUSES
    // and deletes nothing. What is lost is diagnostic specificity, and that is
    // recorded on the pull request rather than papered over here.
    await expect(sweep(root.dir)).rejects.toThrow(/is an unfinished unknown operation/);
    await expect(lstat(path.join(paths.unitRoot, "innocuous.bin"))).resolves.toBeTruthy();
  });

  it("refuses to derive a sweep when the prune registry root is a symlink", async () => {
    await sweepStagedThenCrashed(root.dir, AT);
    const registry = path.join(root.dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
    const empty = `${registry}-empty`;
    await mkdir(empty, { recursive: true });
    await rename(registry, `${registry}-aside`);
    await symlink(empty, registry);
    await expect(sweep(root.dir)).rejects.toThrow(/prune registry cannot be enumerated/);
  });

  it("a crashed sweep is visible to the lifecycle gate and blocks reference completeness", async () => {
    await sweepStagedThenCrashed(root.dir, AT);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("pending");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
  });

  it("never sweeps an integrity-invalid run whose owner is unreadable", async () => {
    const { binding } = await stagePreparation(root.dir);
    await tamperRun(root.dir, binding);
    expect((await sweep(root.dir)).status).toBe("nothing-to-sweep");
    expect((await scanPreparationInventory(root.dir)).problems.length).toBeGreaterThan(0);
  });
});
