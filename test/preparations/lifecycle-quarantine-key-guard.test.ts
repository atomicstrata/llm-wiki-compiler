/**
 * @file test/preparations/lifecycle-quarantine-key-guard.test.ts
 * @description The decisions that consume `inventory.quarantine`, and the
 * boundary that keeps quarantine bytes out of active capacity.
 *
 * Chunk 2 changed where `inventory.quarantine` comes from: previously the
 * combined destructive traversal, now the leased lifecycle snapshot.
 * `assertKeyCompatible` is the ONLY production consumer of its `count`/`bytes`
 * fields, and it governs whether a project may mint its first key epoch. Every
 * parity test asserts those values inside the inventory object; nothing
 * asserted that they still reach the decision that reads them, so deleting the
 * quarantine clause left a fresh key epoch mintable over retained old-epoch
 * bytes with every suite green.
 *
 * The activeBytes assertion covers the same rerouting from the other side. The
 * structural import control names two modules, so any indirection walks past
 * it; a quarantine byte contributing zero to active capacity is the behaviour
 * that control exists to protect, and it holds however the scan is reached.
 */

import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import {
  lifecyclePruneUnitPaths, lifecycleQuarantineUnitPaths,
} from "../../src/preparations/lifecycle-fs/paths.js";
import { scanPreparationLifecycle } from "../../src/preparations/lifecycle-snapshot/scan.js";
import {
  projectLifecyclePending, projectPruneRegistryHealth,
} from "../../src/preparations/lifecycle-snapshot/compat.js";
import {
  lifecycleSnapshotFixture, writePruneReceipts, writeQuarantineReceipts,
} from "./lifecycle-snapshot-fixture.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import {
  resolvePreparationLifecyclePending, settlePreparationHandoffsLocked,
} from "../../src/preparations/recovery.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { openPreparationLifecycleNamespace } from "../../src/preparations/lifecycle-fs/namespace.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import { stageRequest } from "./store-fixture.js";
import { inventoryWithQuarantineFault, redirectLlmwiki, expectFreshKeyStaging, scanWithReceiptRace } from "./lifecycle-storage-fixture.js";

/** Plant one retained quarantine byte object under the lifecycle registry. */
async function retainedQuarantineByte(root: string): Promise<void> {
  const registry = path.join(root, ".llmwiki", "preparation-quarantine");
  await mkdir(registry, { recursive: true });
  await writeFile(path.join(registry, "retained"), "old-epoch-bytes");
}

describe("retained quarantine bytes gate a missing key epoch", () => {
  const root = useTempRoot();

  it("refuses to mint a first key epoch while quarantine bytes are retained", async () => {
    await retainedQuarantineByte(root.dir);
    expect((await readPreparationKey(root.dir)).status).not.toBe("ok");

    await expect(stagePreparationLocked(root.dir, stageRequest()))
      .rejects.toThrow(/key is missing for an active epoch/u);

    // The refusal must not have minted the epoch it was refusing to mint.
    expect((await readPreparationKey(root.dir)).status).not.toBe("ok");
  });

  it("reaches that decision through the inventory quarantine totals", async () => {
    await retainedQuarantineByte(root.dir);
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.quarantine.count).toBe(1);
    expect(inventory.quarantine.bytes).toBeGreaterThan(0);
  });
});

describe("quarantine storage stays outside active capacity", () => {
  const root = useTempRoot();

  it("contributes no active bytes however the active scan is reached", async () => {
    // Behavioural form of the architecture control: the import check names two
    // modules and cannot see an indirection, but a quarantine byte leaking into
    // the active traversal is observable here regardless of how it got there.
    const registry = path.join(root.dir, ".llmwiki", "preparation-quarantine");
    await mkdir(registry, { recursive: true });
    await writeFile(path.join(registry, "blob"), "0123456789");

    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.activeBytes).toBe(0);
    expect(inventory.quarantine).toEqual({ count: 1, bytes: 10, health: "ok" });
  });
});

describe("the snapshot term the prune ungating relies on", () => {
  const root = useTempRoot();

  it("makes complete false from prune health alone, with no snapshot problem", async () => {
    // `snapshot.complete` is the only remaining door for a prune fault after
    // capacity stopped gating on one, and its `storage.prune.health === "ok"`
    // conjunct had no test isolating it. Ten statically-planted fault shapes all
    // failed to isolate it, because a fault present at scan time is also seen by
    // unit classification, which raises a problem that carries `complete` on its
    // own — so deleting the conjunct stayed green and looked redundant.
    //
    // It is not redundant. A fault introduced AFTER classification isolates it:
    // the unit classifies cleanly on the original bytes, `lifecycleUnitStillCurrent`
    // compares dev/ino/realpath/names and an in-place size change alters none of
    // them, so no problem is emitted — but `storageFileStillCurrent` compares the
    // observed byte count and fails, poisoning only prune storage health.
    //
    // Do not generalise this to "post-classification tampering is caught".
    // Revalidation compares dev, ino and SIZE — not content and not mtime — so a
    // same-size content swap passes every pass and the snapshot publishes
    // complete: true over receipt bytes that would fail signature verification.
    // Reproduced, and it is an EXPLICIT NON-BLOCKING LIMITATION, not a defect:
    // producing it requires the active same-UID syscall racer that design V1
    // section 4.2 excludes by name from this task. Legitimate lifecycle writers
    // hold the project lock and use durable create-only protocols, and the next
    // independent capture rejects the forged HMAC. Task 9C promises ONE COHERENT
    // CAPTURED DECISION, not linearizability against a same-UID process rewriting
    // authority bytes mid-scan. Protecting against that actor needs a dated
    // threat-model expansion and a scanner-contract design, not a patch here.
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unitId = "prn-racedracedracedracedracedr";
    await writePruneReceipts({
      namespace: fixture.namespace, key: fixture.key, keyEpochId: fixture.keyEpochId,
      unitId, operation: "prune", objects: [], completed: true,
    });
    const receipt = lifecyclePruneUnitPaths(fixture.namespace, unitId).completedReceiptFile;

    const snapshot = await scanWithReceiptRace(fixture.namespace, receipt);
    expect(snapshot.storage.quarantine.health).toBe("ok");
    expect(snapshot.storage.prune.health).toBe("unavailable");
    // The conjunct is the sole reason this is false. Removing it is a fail-open.
    expect(snapshot.complete).toBe(false);
  });
});

describe("lifecycle health projection is not merely decorative", () => {
  const root = useTempRoot();

  /**
   * Assert the planted fault is IN EFFECT. Every "does not gate" assertion is
   * equally true of a healthy project, so without this the fault setup can be
   * deleted and the test stays green — it would then no longer witness the thing
   * it exists for. The two shapes need different probes: a fault AT the registry
   * path leaves the binding unbindable, while a fault INSIDE a real registry
   * leaves it bound and shows up only as storage health.
   */
  async function expectUnbindablePruneRegistry(dir: string): Promise<void> {
    expect((await openPreparationLifecycleNamespace(dir, "read")).pruneRegistry.status)
      .toBe("unavailable");
  }

  async function expectUnavailablePruneStorage(dir: string): Promise<void> {
    const health = await withPreparationLifecycleRead(dir, (read) =>
      (read.status === "ok" ? read.snapshot.storage.prune.health : "read-unavailable"));
    expect(health).toBe("unavailable");
  }

  /** Plant a redirected entry INSIDE a real prune registry, as the parity suite does. */
  async function faultedPruneRegistry(dir: string): Promise<void> {
    const prune = path.join(dir, ".llmwiki", "preparation-prune");
    await mkdir(prune, { recursive: true });
    const outside = path.join(dir, "outside");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(prune, "planted"));
  }

  it("poisons epoch health from lifecycle problems, not only active ones", async () => {
    // capacity.ts passes the MERGED problem list to summarizeActive. Narrowing it
    // to activeProblems left every suite green, so nothing proved a lifecycle-side
    // fault reaches epoch health at all.
    const quarantine = path.join(root.dir, ".llmwiki", "preparation-quarantine");
    await mkdir(quarantine, { recursive: true });
    const inventory = await inventoryWithQuarantineFault(root.dir, quarantine);
    expect(inventory.epoch.manifests.health).toBe("unavailable");
  });

  it("does not gate when the prune registry itself is not a real directory", async () => {
    // This case was a recorded residual until read-mode binding was separated:
    // a fault AT the registry path failed the whole namespace capture, so
    // capacity raised `lifecycle-storage`, every staging threw, and handoff
    // settlement swallowed the same unavailable inventory and returned with no
    // signal at all. Baseline never walked prune, so that was a regression this
    // task introduced and owns. It is now the same non-gating class as a fault
    // INSIDE the registry, and the fail-closed half lives in
    // lifecycle-prune-binding-degradation.test.ts, which asserts status, GC, the
    // sweep driver, mutate-mode capture, and repair.
    const privateRoot = path.join(root.dir, ".llmwiki");
    await mkdir(privateRoot, { recursive: true });
    const decoy = path.join(root.dir, "prune-registry-decoy");
    await mkdir(decoy, { recursive: true });
    await symlink(decoy, path.join(privateRoot, "preparation-prune"));
    await expectUnbindablePruneRegistry(root.dir);

    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems).toEqual([]);
    expect((await stagePreparationLocked(root.dir, stageRequest())).status).toBe("staged");
    await expect(settlePreparationHandoffsLocked(root.dir)).resolves.toBeUndefined();
  });

  it("still holds GC and the mutation gate on a prune fault", async () => {
    // This is the JUSTIFICATION for keeping prune out of capacity gating: the
    // health is carried on the snapshot for the consumers that genuinely need it.
    // Pinned end to end — a prune fault still holds GC and still refuses the
    // mutation gate. Prune physical health itself is separately covered by
    // lifecycle-storage-races.test.ts, which asserts it across three race families
    // via a computed property; the snapshot term that carries it into `complete`
    // is isolated by the sibling test below.
    await faultedPruneRegistry(root.dir);

    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("unavailable");
  });

  it("mints a first key epoch over a faulted prune registry", async () => {
    // A deliberate relaxation with a non-obvious justification, pinned so the
    // justification travels with it. At 6a5c8a4 this refused; it now proceeds.
    //
    // Prune units are NOT byte-free: they hold signed receipts and del-NNNNNN
    // staged deletes, and a measured unit reported 523 bytes across 2 files. The
    // staged deletes are HARD LINKS to objects already committed to deletion by an
    // authenticated signed plan — not evidence awaiting custody transfer, which is
    // what assertKeyCompatible exists to protect via the quarantine bytes root.
    // assertKeyCompatible has never consulted prune at any commit including
    // baseline, so the old refusal was an accidental side effect of the problems
    // gate rather than a designed custody guard. GC still holds and the pending
    // lifecycle projection still reads unavailable while the registry is
    // unreadable; the lock gate proves that fault confined to prune, so an
    // ORDINARY mutation still proceeds and only mutate-mode capture refuses.
    //
    // If staged deletes ever become a copy or a move rather than a second link to
    // a live object, a faulted prune registry could hold the sole copy of evidence
    // while a fresh epoch is minted over it. This test should then be REVISITED,
    // not updated to match.
    await faultedPruneRegistry(root.dir);
    await expectUnavailablePruneStorage(root.dir);
    await expectFreshKeyStaging(root.dir);
  });

  it("does not let a prune-only fault become a staging dead end", async () => {
    // Design V2 section 5.3 warns that a staging guard added in 9C would be a
    // guard-created dead end, and scopes the refusal to storage NEEDED TO COMPUTE
    // QUARANTINE TOTALS. Prune is explicitly outside those totals and outside the
    // compatibility sum, and baseline capacity never walked the prune registry at
    // all. Gating on it blocked every stagePreparationLocked and silently stopped
    // handoff settlement from the operation-bundle lock gate.
    await faultedPruneRegistry(root.dir);
    await expectUnavailablePruneStorage(root.dir);
    const inventory = await scanPreparationInventory(root.dir);

    expect(inventory.problems).toEqual([]);
    expect(inventory.quarantine).toEqual({ count: 0, bytes: 0, health: "ok" });
  });

  it("reports an unreadable lifecycle capture as unavailable quarantine health", async () => {
    // The unavailable-read branch constructs its own entry; returning "ok" there
    // was invisible to every existing test.
    await redirectLlmwiki(root.dir);

    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.problems.some((problem) => problem.dimension === "lifecycle-storage")).toBe(true);
    expect(inventory.quarantine.health).toBe("unavailable");
  });
});

describe("the sweep driver refuses an unauthoritative prune registry", () => {
  const root = useTempRoot();

  /**
   * A prune fault that poisons storage health WITHOUT raising a problem: an
   * in-place size change after classification. The unit classifies cleanly on the
   * original bytes and its name inventory is unchanged, so no problem is emitted,
   * but the storage revalidation byte-count comparison fails.
   */
  async function racedPruneStorage(dir: string) {
    const fixture = await lifecycleSnapshotFixture(dir);
    const unitId = "prn-racedracedracedracedracer";
    await writePruneReceipts({
      namespace: fixture.namespace, key: fixture.key, keyEpochId: fixture.keyEpochId,
      unitId, operation: "prune", objects: [], completed: true,
    });
    const receipt = lifecyclePruneUnitPaths(fixture.namespace, unitId).completedReceiptFile;
    return { fixture, receipt };
  }

  it("reads unavailable, not clean, when prune storage is unauthoritative", async () => {
    // projectPruneRegistryHealth was the only lifecycle projector ignoring physical
    // storage health, and its consumer is the SWEEP DRIVER. In this state it
    // returned clean, and the driver would derive a new sweep unit and run a
    // two-phase delete against a registry it could not authoritatively observe.
    const { fixture, receipt } = await racedPruneStorage(root.dir);
    const snapshot = await scanWithReceiptRace(fixture.namespace, receipt);
    expect(snapshot.storage.prune.health).toBe("unavailable");
    expect(projectPruneRegistryHealth(snapshot).status).toBe("unavailable");
  });

  it("reopens once the registry can be observed authoritatively", async () => {
    // The supported exit. A new refusal without a tested repair leg is how a
    // fail-closed guard becomes a dead end.
    const { fixture } = await racedPruneStorage(root.dir);
    const settled = await scanPreparationLifecycle(fixture.namespace);
    expect(settled.storage.prune.health).toBe("ok");
    expect(projectPruneRegistryHealth(settled).status).toBe("ok");
  });
});

describe("quarantine storage health reaches its consumers", () => {
  const root = useTempRoot();

  it("keeps the gate closed when quarantine storage is unauthoritative", async () => {
    // The quarantine twin of the prune conjunct test. Dropping
    // `storage.quarantine.health === "ok"` from snapshot.complete left the whole
    // lifecycle battery green while the mutation gate reported clean and GC stopped
    // holding — the same fail-open the prune test exists to prevent. Both conjuncts
    // are now isolated; only the problems conjunct is not, and it cannot be, since
    // every fault that raises a problem also sets a health field.
    const fixture = await lifecycleSnapshotFixture(root.dir);
    const unitId = "qtn-racedracedracedracedraced";
    await writeQuarantineReceipts({
      namespace: fixture.namespace, key: fixture.key, keyEpochId: fixture.keyEpochId,
      unitId, scope: "per-run", objects: [], completed: true,
    });
    const receipt = lifecycleQuarantineUnitPaths(fixture.namespace, unitId).completedReceiptFile;

    const snapshot = await scanWithReceiptRace(fixture.namespace, receipt);
    expect(snapshot.storage.quarantine.health).toBe("unavailable");
    expect(snapshot.complete).toBe(false);
    expect(projectLifecyclePending(snapshot).status).toBe("unavailable");
  });

  it("reports an unwalkable unit subtree rather than under-counting it", async () => {
    // Two legs of one invariant: a unit directory that cannot be listed, and a
    // bytes/ directory that cannot be listed. Both previously left health "ok" with
    // no capacity problem if their guard was removed, so staging would proceed on a
    // silent under-count — and capacity deliberately ignores unit-level problems,
    // so the storage guard is the only thing keeping capacity and the snapshot in
    // agreement here.
    for (const leg of ["unit", "bytes"] as const) {
      const dir = await freshRoot();
      const registry = path.join(dir, ".llmwiki", "preparation-quarantine");
      const unit = path.join(registry, "qtn-unwalkableunwalkableunwa");
      const target = leg === "unit" ? unit : path.join(unit, "bytes");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "obj-one"), "0123456789");
      await chmod(target, 0o000);
      try {
        const inventory = await scanPreparationInventory(dir);
        expect(inventory.quarantine.health).toBe("unavailable");
        expect(inventory.problems.length).toBeGreaterThan(0);
      } finally {
        await chmod(target, 0o700);
      }
    }
  });
});

/** A fresh root per leg, so a chmod fault cannot leak between them. */
async function freshRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "llmwiki-unwalkable-"));
}
