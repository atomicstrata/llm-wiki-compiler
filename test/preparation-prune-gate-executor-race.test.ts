/**
 * @file test/preparation-prune-gate-executor-race.test.ts
 * @description Prune must re-evaluate the gate's decision against its own capture.
 *
 * The sibling of the sweep case. Before the fix this path carried no comparison
 * at all -- the service passed a boolean saying a ticket had existed -- so a prune
 * authorized against one lifecycle state executed under another and deleted three
 * objects belonging to a run the gate never approved touching.
 */
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { workspaceFileNames } from "./preparations/crash-fixture.js";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquirePreparationMutationLock, RecoveryGateError } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { PREPARATION_QUARANTINE_SEGMENT } from "../src/preparations/paths.js";
import { perRunQuarantineUnitId, quarantinePreparationRunLocked } from "../src/preparations/quarantine.js";
import { prunePreparationRunLocked } from "../src/preparations/retention.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { driveToFailed, LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "./preparations/lifecycle-fixture.js";

const OLD = "2026-01-01T00:00:00.000Z";
let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prune-race-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });


/** Every file under the workspaces tree, by path — the identity witness. */
async function survivingObjects(): Promise<string[]> {
  return workspaceFileNames(root);
}

describe("prune re-authorizes against its own capture", () => {
  it("prunes under state that would have refused it at the gate", async () => {
    const { binding } = await stagePreparation(root);
    await driveToFailed(root, binding, OLD);

    const other = await stagePreparation(root);
    await tamperRun(root, other.binding);
    await expect(quarantinePreparationRunLocked(root, {
      binding: other.binding, actor: LIFECYCLE_ACTOR, at: OLD, confirmResidualState: true,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    const unitId = perRunQuarantineUnitId(other.binding.runId);

    const qdir = path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
    const hidden = path.join(root, ".llmwiki", "hidden-q");
    await mkdir(path.dirname(hidden), { recursive: true });
    await rename(path.join(qdir, unitId), hidden);

    const acq = await acquirePreparationMutationLock(root, "prune", {
      targetUnitId: (await import("../src/preparations/prune-delete.js")).pruneUnitIdFor(binding.runId),
    });
    expect(acq.acquired).toBe(true);
    if (!acq.acquired) return;
    expect(acq.authorization.ticket).toBeNull();

    await rename(hidden, path.join(qdir, unitId));
    expect((await resolvePreparationLifecyclePending(root)).status).toBe("pending");

    const objectsBefore = await survivingObjects();
    let outcome: string;
    let thrown: unknown = null;
    try {
      const receipt = await prunePreparationRunLocked(root, {
        authorization: acq.authorization,
        target: { kind: "run", binding }, actor: LIFECYCLE_ACTOR, at: OLD, clock: { now: () => new Date() },
      });
      outcome = `PRUNED ${receipt.objects.length} object(s)`;
    } catch (error) {
      thrown = error;
      outcome = `refused(${(error as Error).name})`;
    } finally { await releaseLock(root); }

    // IDENTITY, NOT A COUNT, for the same reason as the sweep case. Before the
    // fix this deleted three objects belonging to a run the gate never
    // authorized touching.
    // AND THE CLASS MUST BE ONE THE SERVICE CONVERTS. Asserting only "not
    // deleted" is what hid a real defect: the deletion was prevented and the
    // substrate threw PreparationLifecycleGateError, which neither service
    // classified, so through the CLI or SDK the operation violated its own
    // returned-refusal contract and produced an empty envelope. A catch-all that
    // records any error as "refused(...)" cannot tell a returned refusal from a
    // throw -- the two are the same observation to it.
    //
    // Every arm of the gate's predicate is now classified at both services, so
    // pinning the BASE class here fails if the driver ever raises something
    // outside it.
    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(RecoveryGateError);
    //
    // WHAT THIS PINS AND WHAT IT DOES NOT. It pins that the driver raises only a
    // class both services convert -- so an unclassified escape fails here. It
    // does NOT drive the service end to end for this arm: reaching the driver's
    // re-evaluation through the public entry needs the lifecycle to change
    // between the acquisition and the drive, and a single-threaded caller cannot
    // do that without a fault seam the options type deliberately refuses. The
    // conversion itself is pinned by the services' own refusal cases.

    // Compile-clean mutation evidence, as above: under a type-preserving
    // neutralization of the driver's re-authorization this case fails with three
    // of six objects gone.
    expect(await survivingObjects()).toEqual(objectsBefore);
    expect(outcome.startsWith("PRUNED")).toBe(false);
  });
});
