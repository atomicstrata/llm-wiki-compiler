/**
 * @file test/storage/lifecycle-gate-binding.test.ts
 * @description The mutation gate's preparation-lifecycle leg as ONE root-free
 * decision body, `gatePreparationLifecycleFrom(LifecycleGateReads, intent, target)`,
 * over two reads: the legacy private-alias shortcut and ONE projected pending
 * capture. Every root form reaches it through `diskLifecycleGateReads(root)`.
 *
 * HOW IT IS BUILT. Memory cases hand the body scripted pending-state PROJECTIONS
 * (the type the capture produces) and an alias answer; they prove the body's arm
 * order, read discipline and refusals, not the capture, which stays in the local
 * lifecycle-fs code and is covered by the disk journey here and the existing
 * lifecycle-gate suites. The disk journey crashes a REAL sweep through the shipped
 * driver (`lifecycle-fixture.ts`) and resumes it through the shipped service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { cliPreparationService } from "../../src/commands/preparation/host.js";
import {
  acquireMutationLock, diskLifecycleGateReads, gatePreparationLifecycleFrom, PreparationLifecycleGateError,
  PreparationLifecycleUnobservableError, type LifecycleGateReads, type RecoveryGateIntent,
} from "../../src/operation-bundles/lock-gate.js";
import { PREPARATION_PRUNE_REGISTRY, PREPARATION_QUARANTINE_SEGMENT } from "../../src/preparations/paths.js";
import * as recovery from "../../src/preparations/recovery.js";
import type { LifecyclePendingUnitV1, PreparationLifecyclePendingState } from "../../src/preparations/recovery.js";
import * as legacyLayout from "../../src/utils/legacy-private-layout.js";
import { releaseLock } from "../../src/utils/lock.js";
import { faultableProjectRoot } from "../preparation-destructive-fixture.js";
import { sweepStagedThenCrashed } from "../preparations/lifecycle-fixture.js";

const ALIAS_NAMES = [PREPARATION_QUARANTINE_SEGMENT, PREPARATION_PRUNE_REGISTRY];
/** Sweep units live in the prune registry, where the shared sweep-target selector looks for them. */
const SWEEP_UNIT: LifecyclePendingUnitV1 = { registry: "prune", operation: "orphan-sweep", unitId: "unit-sweep" };
const PRUNE_UNIT: LifecyclePendingUnitV1 = { registry: "prune", operation: "run-prune", unitId: "unit-prune" };
const CLEAN: PreparationLifecyclePendingState = { status: "clean" };

/** A pending projection with the given units; observable and complete unless overridden. */
function pending(units: LifecyclePendingUnitV1[], over: Partial<Extract<PreparationLifecyclePendingState, { status: "pending" }>> = {}): PreparationLifecyclePendingState {
  return { status: "pending", units, unobservableRegistries: [], complete: true, problemRegistries: [], ...over };
}

/** An unavailable projection attributed to the given registries. */
function unavailable(registries: ("quarantine" | "prune")[]): PreparationLifecyclePendingState {
  return { status: "unavailable", detail: "capture failed", registries };
}

/** Scripted reads; `alias` undefined means the alias must never be asked. Every call logged. */
function memory(state: PreparationLifecyclePendingState | undefined, alias: boolean | undefined, log: unknown[]): LifecycleGateReads {
  return {
    privateAliasHasNoEntries: async (names) => { log.push(["alias", names]); if (alias === undefined) throw new Error("alias asked"); return alias; },
    readLifecyclePending: async () => { log.push("pending"); if (state === undefined) throw new Error("pending read"); return state; },
  };
}

/** Run the body once; the decision (ticket, null, or the refusal's class) and the read log. */
async function decide(intent: RecoveryGateIntent, state: PreparationLifecyclePendingState | undefined, alias?: boolean, target?: string) {
  const log: unknown[] = [];
  const outcome = await gatePreparationLifecycleFrom(memory(state, alias, log), intent, target)
    .catch((error: Error) => error.constructor.name);
  return [outcome, log];
}

describe("the lifecycle-gate decision body (memory projections)", () => {
  it("L1 returns null for reset before ANY read, whatever the project holds", async () => {
    expect(await decide("reset", undefined)).toEqual([null, []]);
  });

  it("L2 lets a non-destructive intent short-circuit on the alias proof with the exact names, and otherwise reads ONE pending capture", async () => {
    expect(await decide("ordinary", undefined, true)).toEqual([null, [["alias", ALIAS_NAMES]]]);
    expect(await decide("ordinary", CLEAN, false)).toEqual([null, [["alias", ALIAS_NAMES], "pending"]]);
    expect(await decide("handoff", pending([SWEEP_UNIT]), false)).toEqual(["PreparationLifecycleGateError", [["alias", ALIAS_NAMES], "pending"]]);
  });

  it("L3 never lets a destructive intent ask the alias, and derives the sweep target from the SAME pending units", async () => {
    expect(await decide("sweep", pending([SWEEP_UNIT]))).toEqual([{ operation: "orphan-sweep", unitId: SWEEP_UNIT.unitId }, ["pending"]]);
    expect(await decide("prune", pending([PRUNE_UNIT]), undefined, PRUNE_UNIT.unitId)).toEqual([{ operation: "run-prune", unitId: PRUNE_UNIT.unitId }, ["pending"]]);
    expect(await decide("prune", CLEAN, undefined, PRUNE_UNIT.unitId)).toEqual([null, ["pending"]]);
    expect((await decide("sweep", pending([SWEEP_UNIT]), undefined, "supplied"))[0]).toBe("PreparationLifecycleGateError");
  });

  it("L4 degrades an ordinary mutation past a prune-only fault, but refuses a quarantine or unattributed one", async () => {
    expect((await decide("ordinary", unavailable(["prune"]), false))[0]).toBeNull();
    expect((await decide("ordinary", unavailable(["quarantine"]), false))[0]).toBe("PreparationLifecycleGateError");
    expect((await decide("ordinary", unavailable([]), false))[0]).toBe("PreparationLifecycleGateError");
  });

  it("L5 refuses a destructive resume beside an unobservable quarantine registry or an unattributed incompleteness, and allows a prune-confined one", async () => {
    const owner = (state: PreparationLifecyclePendingState) => decide("prune", state, undefined, PRUNE_UNIT.unitId);
    expect((await owner(pending([PRUNE_UNIT], { unobservableRegistries: ["quarantine"] })))[0]).toBe("PreparationLifecycleUnobservableError");
    expect((await owner(pending([PRUNE_UNIT], { complete: false, problemRegistries: [] })))[0]).toBe("PreparationLifecycleUnobservableError");
    expect((await owner(unavailable(["prune"])))[0]).toBe("PreparationLifecycleUnobservableError");
    expect((await owner(pending([PRUNE_UNIT], { complete: false, problemRegistries: ["prune"] })))[0]).toEqual({ operation: "run-prune", unitId: PRUNE_UNIT.unitId });
  });
});

describe("the lifecycle-gate decision over the local-disk reads (real crashed sweep)", () => {
  const projectRoot = faultableProjectRoot("lifecycle-gate-binding-");
  let root = "";
  beforeEach(async () => { root = await projectRoot.make(); });
  afterEach(async () => { vi.restoreAllMocks(); await projectRoot.remove(root); });

  it("L6 refuses, then tickets the owning sweep, then clears — through the body over disk reads and the shipped root form alike", async () => {
    const unitId = await sweepStagedThenCrashed(root, "2026-08-06T00:00:00.000Z");
    await expect(gatePreparationLifecycleFrom(diskLifecycleGateReads(root), "ordinary", undefined)).rejects.toBeInstanceOf(PreparationLifecycleGateError);
    await expect(acquireMutationLock(root, "ordinary")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
    expect(await gatePreparationLifecycleFrom(diskLifecycleGateReads(root), "sweep", undefined)).toEqual({ operation: "orphan-sweep", unitId });
    expect((await cliPreparationService(root).sweep()).status).toBe("swept");
    expect(await gatePreparationLifecycleFrom(diskLifecycleGateReads(root), "ordinary", undefined)).toBeNull();
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
  });

  it("L7 makes no ambient read from the body over memory reads, while the root form asks the alias with exactly its names and reads the capture", async () => {
    const alias = vi.spyOn(legacyLayout, "legacyPrivateAliasHasNoEntries");
    const capture = vi.spyOn(recovery, "resolvePreparationLifecyclePending");
    await gatePreparationLifecycleFrom(memory(CLEAN, false, []), "ordinary", undefined);
    await gatePreparationLifecycleFrom(memory(CLEAN, undefined, []), "sweep", undefined);
    expect([alias.mock.calls.length, capture.mock.calls.length]).toEqual([0, 0]);
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    expect(alias.mock.calls).toEqual([[root, ALIAS_NAMES]]);
    // The second argument is the gate pass's shared lifecycle reads.
    expect(capture.mock.calls.map(([called]) => called)).toEqual([root]);
  });
});
