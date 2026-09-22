/**
 * @file test/preparation-destructive-unattributed-evidence.test.ts
 * @description R-9's THIRD arm: a destructive operation refuses an
 * incompleteness that names no registry at all.
 *
 * WHY IT IS SPLIT INTO A PROJECTOR TEST AND A GATE TEST. The state needs a write
 * that lands DURING the scan, and the scan seams (`afterClassificationForTest`
 * and friends) are reachable only by calling `scanPreparationLifecycle`
 * directly. The gate's own read path passes no options — deliberately, because
 * `withPreparationLifecycleRead`'s options type is one field so a caller cannot
 * steer the scanner — so an end-to-end gate test on the raced state would need a
 * new seam in a read authority that exists to stay narrow. Widening it to make a
 * test easier would trade a real property for convenience.
 *
 * So: the FIRST test proves the projection genuinely EMITS this state, with the
 * real scanner against a real filesystem. The SECOND proves the gate's answer
 * GIVEN that state. Together they cover the property; neither alone does, and
 * the synthetic value in the second is not a weakening because the first is what
 * establishes the value is real.
 *
 * THE WRITE TARGET IS THE REGISTRY ROOT, and that is the acceptance condition
 * rather than a detail. A write into a UNIT is caught by the re-prove loop and
 * produces `operation: null` PLUS a problem — a state the confinement rule
 * already handles — so the test would pass while this arm stayed unwitnessed.
 * A write into the ROOT is seen only by storage revalidation, which marks the
 * snapshot incomplete and raises NO problem. That is the state nothing else
 * reaches.
 *
 * THE UNEXERCISABLE SIBLINGS ARE A CLOSED DISPOSITION, NOT A TODO. Three code
 * paths reach `complete: false` with no problem raised: registry-entry
 * exhaustion (needs a 100,000-entry ceiling), `enumerateRegistryRoot`'s own
 * instability window, and an identity conflict observing one inode at two sizes.
 * All three need the perturbation to land INSIDE a paired before/after
 * observation, and every test seam fires BETWEEN phases — so no fourth hook
 * would help; only a seam inside a paired observation would, which is exactly
 * what the narrow options type refuses. One route is enough because THE ARM
 * KEYS ON THE STATE, NOT THE ROUTE, and all three converge on the identical
 * observable state, which this test pins.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openPreparationLifecycleNamespace } from "../src/preparations/lifecycle-fs/namespace.js";
import { scanPreparationLifecycle } from "../src/preparations/lifecycle-snapshot/scan.js";
import { projectLifecyclePending } from "../src/preparations/lifecycle-snapshot/compat.js";
import type { PreparationLifecycleSnapshotV1 } from "../src/preparations/lifecycle-snapshot/types.js";
import { PREPARATION_QUARANTINE_SEGMENT } from "../src/preparations/paths.js";
import { pruneStagedBytesThenCrashed } from "./preparations/lifecycle-fixture.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-unattributed-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Scan the project's lifecycle, optionally racing a write into a registry root. */
async function scanRacing(racedRegistryRoot?: string): Promise<PreparationLifecycleSnapshotV1> {
  const namespace = await openPreparationLifecycleNamespace(root, "read");
  return scanPreparationLifecycle(namespace, racedRegistryRoot === undefined ? {} : {
    // SEAM: after pass-one classification and BEFORE storage revalidation, which
    // is the window in which a root change goes unattributed.
    afterClassificationForTest: async () => {
      await writeFile(path.join(racedRegistryRoot, "raced-entry"), "raced");
    },
  });
}

/** Every unit whose provenance the scan could not establish. */
function nullUnits(snapshot: PreparationLifecycleSnapshotV1): readonly unknown[] {
  return snapshot.units.filter((unit) => unit.operation === null);
}

describe("the projection EMITS an incompleteness that names no registry", () => {
  it("reports complete:false with no problems when a registry ROOT is raced", async () => {
    await pruneStagedBytesThenCrashed(root, "2026-08-08T00:00:00.000Z");
    const quarantineRoot = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);

    // THE PRECONDITION ROW: without the race the state does not arise. Without
    // this, a fixture that stopped racing would still "pass" while proving that
    // a healthy project is healthy.
    const baseline = await scanRacing();
    expect(baseline.complete).toBe(true);
    expect(baseline.storage.quarantine.health).toBe("ok");
    expect(nullUnits(baseline)).toHaveLength(0);

    const raced = await scanRacing(quarantineRoot);

    // (1) incomplete...
    expect(raced.complete).toBe(false);
    // (2) ...and NOTHING is attributed. A problem here means the write landed on
    // a unit rather than the root, which is a state the confinement rule already
    // covers — the test would pass while this arm went unwitnessed.
    expect(raced.problems).toEqual([]);
    // (3) no unit anywhere lost its provenance — ANYWHERE, not just quarantine.
    // This is the premise the arm rests on: neither the custody rule nor any
    // provenance-scoped rule can reach this state.
    expect(nullUnits(raced)).toHaveLength(0);
    // (4) and the work-pending unit survived, so the pending arm still wins.
    expect(raced.units.some((unit) => unit.operation === "run-prune")).toBe(true);

    // Which projects to exactly the shape the gate must refuse on.
    expect(projectLifecyclePending(raced)).toMatchObject({
      status: "pending", unobservableRegistries: [], complete: false, problemRegistries: [],
    });
  });
});

/**
 * The gate's answer GIVEN that state.
 *
 * Only `resolvePreparationLifecyclePending` is substituted; everything the gate
 * does with the value is real. Forging a read further down is refused by the
 * scanner's own brand check ("lifecycle read was not scanner-minted"), and a
 * probe refusing for THAT reason looks exactly like a working fix.
 */
const observation = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../src/preparations/recovery.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/preparations/recovery.js")>(),
  resolvePreparationLifecyclePending: async () => observation.value,
}));

describe("the gate REFUSES on an incompleteness that names no registry", () => {
  it("refuses a destructive resume, and still admits one that is prune-confined", async () => {
    const { acquirePreparationMutationLock, PreparationLifecycleUnobservableError } =
      await import("../src/operation-bundles/lock-gate.js");
    const { releaseLock } = await import("../src/utils/lock.js");
    const unit = { registry: "prune" as const, operation: "run-prune" as const, unitId: "prn-owned" };

    // G3 — incomplete, attributing nothing. Refuses.
    observation.value = {
      status: "pending", units: [unit], unobservableRegistries: [], complete: false,
      problemRegistries: [],
    };
    await expect(acquirePreparationMutationLock(root, "prune", { targetUnitId: "prn-owned" }))
      .rejects.toBeInstanceOf(PreparationLifecycleUnobservableError);

    // N2 — incomplete, but ATTRIBUTED to the prune registry alone. Proceeds:
    // a key reset lives in the quarantine registry, so a prune-confined
    // incompleteness conceals nothing that forbids this delete, and refusing
    // would strand a resume over residue no verb can retire.
    //
    // THE `problemRegistries` EMPTINESS IS THE WHOLE DISTINCTION between these
    // two rows, and it is the conjunct a later reader will think redundant.
    observation.value = {
      status: "pending", units: [unit], unobservableRegistries: [], complete: false,
      problemRegistries: ["prune"],
    };
    const acquired = await acquirePreparationMutationLock(root, "prune", { targetUnitId: "prn-owned" });
    // The acquisition now returns the DECISION -- the question the gate was asked
    // alongside the answer it gave -- so the executor can re-run the same
    // predicate over its own capture instead of comparing a value it composed.
    expect(acquired).toEqual({
      acquired: true,
      authorization: {
        intent: "prune", targetUnitId: "prn-owned",
        ticket: { operation: "run-prune", unitId: "prn-owned" },
      },
    });
    await releaseLock(root);
  });
});

/**
 * THE CONFINEMENT PREDICATE'S CONTRACT, at BOTH call sites that depend on it.
 *
 * WHY THIS EXISTS EVEN THOUGH TWO BEHAVIOURAL TESTS ALREADY KILL THE MUTANT.
 * Both of those reach the empty-attribution case through a FILESYSTEM FIXTURE
 * that happens to produce a whole-capture failure. That is real coverage and it
 * is incidental: change either fixture for an unrelated reason and the property
 * silently loses its witness, with no test naming what was lost. These rows
 * reach the same states directly, so they cannot drift.
 *
 * WHAT IS ACTUALLY LOAD-BEARING is one token — `registries.length > 0` inside
 * `degradesToPruneOnly`. `[].every(...)` is `true` in JavaScript, so without it
 * an EMPTY set reads as "every named registry is prune, and none are named" and
 * an unattributable fault would be treated as proven prune-confined. Absence of
 * evidence is not evidence of confinement, and this is the line that says so.
 *
 * THE TWO CALL SITES HAVE DIFFERENT CONSEQUENCES, which is why both are here:
 *
 *  - the ORDINARY leg's `unavailable` arm — deleting the token lets an ordinary
 *    mutation proceed against a project whose lifecycle state could not be read
 *    at all. That is the larger exposure and it is NOT on the destructive path.
 *  - this slice's incompleteness arm — deleting it stops the arm firing on an
 *    unattributed incompleteness, so the third arm closes nothing.
 *
 * The predicate is module-private and stays byte-identical, so the contract is
 * asserted where it is observed rather than by widening the module's surface
 * for a test.
 */
describe("an empty attribution set is never evidence of confinement", () => {
  /**
   * Take the gate at one intent and report whether it let the caller in.
   *
   * IT CATCHES THE TYPED REFUSAL AND NOTHING ELSE. A bare catch here would make
   * a `false` row mean "the guard refused" OR "anything at all threw" — the
   * observing-a-throw-is-not-a-refusal class, and the one place in this control
   * where a future edit could quietly stop discriminating. Today the control
   * still dies under the mutation, so the weakness is latent rather than live;
   * that is exactly when it is cheap to remove.
   */
  async function acquires(intent: "ordinary" | "prune"): Promise<boolean> {
    const { acquireMutationLock, acquirePreparationMutationLock, PreparationLifecycleGateError } =
      await import("../src/operation-bundles/lock-gate.js");
    const { releaseLock } = await import("../src/utils/lock.js");
    try {
      if (intent === "ordinary") {
        const ok = await acquireMutationLock(root, "ordinary");
        if (ok) await releaseLock(root);
        return ok;
      }
      const acquired = await acquirePreparationMutationLock(root, "prune", { targetUnitId: "prn-owned" });
      if (acquired.acquired) await releaseLock(root);
      return acquired.acquired;
    } catch (error) {
      if (error instanceof PreparationLifecycleGateError) return false;
      throw error;
    }
  }

  const unit = { registry: "prune" as const, operation: "run-prune" as const, unitId: "prn-owned" };

  it.each([
    ["names nothing", [], false],
    ["names prune alone", ["prune"], true],
    ["names both registries", ["quarantine", "prune"], false],
  ])("ORDINARY: a whole-read failure that %s", async (_label, registries, expected) => {
    observation.value = {
      status: "unavailable", detail: "capture is unavailable", registries,
    };
    expect(await acquires("ordinary")).toBe(expected);
  });

  it.each([
    ["names nothing", [], false],
    ["names prune alone", ["prune"], true],
    ["names both registries", ["quarantine", "prune"], false],
  ])("DESTRUCTIVE: an incompleteness that %s", async (_label, problemRegistries, expected) => {
    observation.value = {
      status: "pending", units: [unit], unobservableRegistries: [], complete: false, problemRegistries,
    };
    expect(await acquires("prune")).toBe(expected);
  });
});
