/**
 * @file test/preparations/lifecycle-prune-binding-degradation.test.ts
 * @description The read-mode namespace boundary for a prune registry that is not
 * a real directory at its canonical path — a symlink, a regular file, or an
 * identity that drifted under the capture.
 *
 * Task 9C routed capacity through the leased lifecycle snapshot, which binds both
 * physical registries before anything is observed. Binding them TOGETHER made a
 * prune-root fault reject the whole read, so `scanPreparationInventory` reported
 * `lifecycle-storage`, every `stagePreparationLocked` threw, and handoff
 * settlement — reached unconditionally from the operation-bundle lock gate —
 * swallowed the same unavailable inventory and returned with no signal at all.
 * Baseline capacity never walked the prune registry, so that was a regression
 * introduced by this task and owned by it.
 *
 * The boundary is asymmetric on purpose. Capacity is authoritative on QUARANTINE
 * storage: its totals gate key-epoch compatibility, so a quarantine binding fault
 * must still reject the read. Prune is outside quarantine totals, outside the
 * compatibility sum, and never entered capacity's problems, so a prune binding
 * fault degrades to prune-specific unavailable state instead. Everything that
 * genuinely needs prune — status, reference completeness/GC, and the sweep driver
 * — reads that state and stays fail-closed, and mutate-mode capture still refuses
 * outright, because a destructive operation may not write into a registry it
 * cannot bind.
 */

import { gateDecision } from "./lifecycle-fixture.js";
import { lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectFreshKeyStaging } from "./lifecycle-storage-fixture.js";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { PREPARATION_PRUNE_REGISTRY, preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import { resolvePreparationLifecyclePending, settlePreparationHandoffsLocked } from "../../src/preparations/recovery.js";
import { sweepPreparationOrphansLocked } from "../../src/preparations/retention.js";
import { openPreparationLifecycleNamespace } from "../../src/preparations/lifecycle-fs/namespace.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { handoffPreparation } from "../../src/preparations/handoff.js";
import { acquireMutationLockBlocking } from "../../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../../src/utils/lock.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, sweepStagedThenCrashed,
} from "./lifecycle-fixture.js";
import { MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked } from "../../src/preparations/reset.js";
import { fixturePlan, stageRequest } from "./store-fixture.js";
import {
  CRASH_AFTER_STAGE, expectRunState, handoffRequest, stageReadyPreparation,
} from "./handoff-fixture.js";

const AT = "2026-07-29T00:00:00.000Z";

const root = useTempRoot();

/** Replace the canonical prune registry with a symlink to a decoy directory. */
async function redirectPruneRegistry(dir: string): Promise<void> {
  const registry = path.join(dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
  const decoy = path.join(dir, "prune-registry-decoy");
  await mkdir(path.dirname(registry), { recursive: true });
  await mkdir(decoy, { recursive: true });
  await rm(registry, { recursive: true, force: true });
  await symlink(decoy, registry);
}

/** Redirect the registry while preserving the units it already holds. */
async function redirectPruneRegistryKeepingUnits(dir: string): Promise<void> {
  const registry = path.join(dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
  const decoy = path.join(dir, "prune-registry-decoy");
  await mkdir(decoy, { recursive: true });
  await rename(registry, `${registry}-aside`);
  await symlink(decoy, registry);
}

/** Restore a real, empty prune registry at the canonical path. */
async function repairPruneRegistry(dir: string): Promise<void> {
  const registry = path.join(dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
  await rm(registry, { recursive: true, force: true });
  await mkdir(registry, { mode: 0o700, recursive: true });
}

const sweep = (dir: string) => sweepPreparationOrphansLocked(dir, { actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep")});

describe("a prune registry that cannot be bound degrades prune, not the whole read", () => {
  it("keeps staging and a real handoff settlement working", async () => {
    // The regression this closes. Both operations are prune-independent: staging
    // consults quarantine totals, and settlement consults capacity problems.
    const binding = await stageReadyPreparation(root.dir);
    await expect(handoffPreparation(root.dir, handoffRequest(binding, "ada", { faultsForTest: CRASH_AFTER_STAGE })))
      .rejects.toThrow("crash");
    await expectRunState(root.dir, binding, "handoff-started");
    await redirectPruneRegistry(root.dir);
    // Assert the fault is IN EFFECT before asserting what survives it. Every other
    // assertion in this test is equally true of a healthy project, so without this
    // line deleting the fault setup leaves the test green — and it would then no
    // longer detect the regression it exists for. A test that cannot notice losing
    // its own precondition is not pinning the precondition.
    expect((await openPreparationLifecycleNamespace(root.dir, "read")).pruneRegistry.status)
      .toBe("unavailable");

    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine.health).toBe("ok");

    // The lock gate reaches settlement unconditionally; the crashed handoff must
    // actually reach `handed-off` rather than be silently skipped.
    await acquireMutationLockBlocking(root.dir, "ordinary");
    await releaseLock(root.dir);
    await expectRunState(root.dir, binding, "handed-off");

    const staged = await stagePreparationLocked(root.dir, stageRequest(fixturePlan()));
    expect(staged.status).toBe("staged");
  });

  it("holds status, reference completeness, and the sweep driver fail-closed", async () => {
    // Staging first so a key epoch exists: without one the sweep driver returns
    // null before it ever consults the prune registry, and the assertion below
    // would pass for the wrong reason.
    await stagePreparationLocked(root.dir, stageRequest());
    await redirectPruneRegistry(root.dir);

    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
    const references = await enumeratePreparationReferences(root.dir);
    expect(references.complete).toBe(false);
    expect(references.problems.some((problem) => problem.dimension === "quarantine")).toBe(true);
    // The sweep driver refuses through the prune registry problem the observer
    // records for an unbindable registry, before the storage-health term is
    // reached. Both terms are fail-closed; this pins which one actually fires,
    // and that the refusal names the BINDING fault rather than only the family
    // it shares with a bound-but-unreadable registry.
    await expect(sweep(root.dir))
      .rejects.toThrow(/prune registry cannot be enumerated: preparation-prune is unavailable/u);
  });

  it("records prune storage as unavailable, not merely problematic", async () => {
    // Two independent terms carry a binding fault to the prune consumers: the
    // observation PROBLEM and the physical storage health. Every consumer
    // assertion above is satisfied by the problem term alone, so removing the
    // storage-health assignment left them all green. Storage health answers
    // "could I observe this?" and a registry that was never bound was never
    // observed; `projectPruneRegistryHealth` fails closed on it precisely because
    // several unobservable states raise no problem at all. Asserted directly so
    // the term cannot be dropped as apparently-redundant.
    await redirectPruneRegistry(root.dir);

    const storage = await withPreparationLifecycleRead(root.dir, (read) =>
      (read.status === "ok" ? read.snapshot.storage : null));
    expect(storage?.prune.health).toBe("unavailable");
    expect(storage?.quarantine.health).toBe("ok");
  });

  it("refuses a mutate-mode capture outright", async () => {
    // Destructive operations bind through mutate mode. Degrading there would let a
    // two-phase delete stage receipts into a registry whose identity is unproved,
    // so this half stays strictly fail-closed. `sweep` above is the production
    // destructive path; this asserts the boundary those paths share.
    //
    // Mutate-mode refusal is enforced by TWO terms — the explicit mode guard at
    // the prune capture, and `createChild`, which cannot mkdir over an occupied
    // path and rebinds strictly afterwards. This control proves the property, not
    // which term delivered it: deleting the mode guard alone leaves it green.
    //
    // That was first disclosed here as an EQUIVALENT mutant. It is not — it is only
    // uncaught. Adversarial review showed `createChild`'s EEXIST path re-runs
    // `captureChild`, so an identity drift that cleared between the two attempts
    // would bind in mutate mode: a second attempt the module otherwise forbids. The
    // race has no seam to drive deterministically, so it stays unpinned, but the
    // mode guard is doing real work and must not be read as redundant.
    await redirectPruneRegistry(root.dir);

    await expect(openPreparationLifecycleNamespace(root.dir, "mutate"))
      .rejects.toMatchObject({ code: "registry-unavailable" });
    await expect(openPreparationLifecycleNamespace(root.dir, "read")).resolves.toBeDefined();
  });

  it("degrades a regular file at the registry path the same way", async () => {
    // A symlink is the tamper-shaped case; a plain file is the corruption-shaped
    // one. Both are binding faults and neither may reject the whole read.
    const registry = path.join(root.dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, "not a registry");

    expect((await scanPreparationInventory(root.dir)).problems).toEqual([]);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
  });

  it("closes the reset door once an epoch is minted over an unbindable registry", async () => {
    // The consequence of the staging relaxation, pinned because 588f247 WIDENS the
    // set of fault shapes that reach it. Minting the first epoch is what capacity's
    // problems gate; once minted, the key is healthy, and a project reset requires a
    // missing or unreadable key — so the reset door closes while prune bytes sit
    // outside custody, and repairing the registry does not reopen it.
    //
    // This is pre-existing and accepted, not introduced here: the sibling test
    // "mints a first key epoch over a faulted prune registry" asserts the same mint
    // for a fault INSIDE a real registry, and that shape reaches the same dead end.
    // Nothing pinned the CONSEQUENCE, so a change to it would have been invisible.
    // If this behaviour ever changes, REVISIT the relaxation — do not update this
    // test to match.
    await redirectPruneRegistry(root.dir);
    // Assert the fault is IN EFFECT before asserting what survives it. Every other
    // assertion in this test is equally true of a healthy project, so without this
    // line deleting the fault setup leaves the test green — and it would then no
    // longer detect the regression it exists for. A test that cannot notice losing
    // its own precondition is not pinning the precondition.
    expect((await openPreparationLifecycleNamespace(root.dir, "read")).pruneRegistry.status)
      .toBe("unavailable");
    await expectFreshKeyStaging(root.dir);

    const refusal = { code: "key-healthy" };
    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
    })).rejects.toMatchObject(refusal);

    await repairPruneRegistry(root.dir);
    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
    })).rejects.toMatchObject(refusal);
  });

  it("refuses reset custody when the prune registry cannot be bound", async () => {
    // `resolveResetKey` returns early when the active key already equals the staged
    // reset epoch, and that branch opens no mutate namespace — so custody
    // enumeration is reached here under a READ-mode open, which no longer throws.
    // At the parent commit the protection came free from that open failing;
    // degrading the read replaced an implicit guarantee with an explicit guard.
    //
    // Measured, not assumed: with the guard replaced by `return []` (mirroring the
    // `absent` line below it) the mutant COMPILES and 56 tests across the reset,
    // quarantine, prune and degradation suites still pass.
    //
    // The mutant DOES still throw — and that is a trap. It throws
    // "preparation-prune is unavailable" from the crash-material cleanup, which runs
    // AFTER the quarantine has committed: probing the mutant leaves the planned AND
    // completed receipts on disk, signed under the fresh epoch, with the active store
    // already consumed. A rerun once the registry is repaired then reports
    // `completed` while the prune unit still sits outside custody — permanently
    // unverifiable, since the epoch that authenticated it is gone. With the guard,
    // the same probe leaves neither receipt and the unit holds only its pre-commit
    // intent files. So this guard is the SOLE barrier before an irreversible move,
    // not defence in depth.
    //
    // The object list is not empty under the mutant — it still carries every ACTIVE
    // leaf — which is exactly why the commit proceeds and only the prune leaves are
    // dropped. An earlier reading of this scenario stopped at "the rerun still
    // refuses" and called it defence in depth. Observing a throw is not observing a
    // refusal: the question is whether anything committed before it.
    //
    // The assertion therefore pins the COMMITMENT, not just the message: a guard
    // moved, renamed, or reworded still has to leave both receipts absent.
    await stagePreparation(root.dir);
    await sweepStagedThenCrashed(root.dir, AT);
    await removePreparationKey(root.dir);
    const started = await resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION,
    });
    if (started.status !== "intent-recorded") throw new Error(`unexpected ${started.status}`);
    const continuation = { unitId: started.unitId, token: started.continuationToken };
    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation,
      faults: { afterKeyMint: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");

    await redirectPruneRegistryKeepingUnits(root.dir);

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation,
    })).rejects.toThrow(/prune registry cannot be bound for custody/u);

    const unit = preparationQuarantineUnitPaths(root.dir, started.unitId);
    await expect(lstat(unit.plannedReceiptFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(unit.completedReceiptFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns to fully clean state once the registry is repaired", async () => {
    // A guard that leaves a legitimate state unrecoverable is a defect in its own
    // right, so recovery is asserted rather than assumed.
    await stagePreparationLocked(root.dir, stageRequest());
    await redirectPruneRegistry(root.dir);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
    expect((await scanPreparationInventory(root.dir)).problems).toEqual([]);

    await repairPruneRegistry(root.dir);

    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(true);
    await expect(sweep(root.dir)).resolves.toEqual({ status: "nothing-to-sweep" });
    await expect(openPreparationLifecycleNamespace(root.dir, "mutate")).resolves.toBeDefined();
  });
});
