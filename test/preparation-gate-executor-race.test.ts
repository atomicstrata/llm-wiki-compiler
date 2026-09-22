/**
 * @file test/zz-repro-gate-driver-race.test.ts
 * @description REPRODUCTION. The gate authorizes against one lifecycle snapshot
 * and the destructive executor deletes under a different one.
 *
 * The gate captures at `gatePreparationLifecycle`; the executor captures again
 * inside the driver and re-checks only the PRUNE-registry sweep target, so
 * quarantine/reset state that became visible in between is never consulted.
 */

import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquirePreparationMutationLock, RecoveryGateError } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { PREPARATION_QUARANTINE_SEGMENT, preparationPaths } from "../src/preparations/paths.js";
import { crashQuarantine, workspaceFileNames } from "./preparations/crash-fixture.js";
import { sweepPreparationOrphansLocked } from "../src/preparations/retention.js";
import { resolvePreparationLifecyclePending } from "../src/preparations/recovery.js";
import { LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "./preparations/lifecycle-fixture.js";

const AT = "2026-08-09T00:00:00.000Z";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-race-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The quarantine registry directory for this project. */
function quarantineDir(): string {
  return path.join(root, ".llmwiki", PREPARATION_QUARANTINE_SEGMENT);
}

/** Stage a preparation and delete its run leaf, leaving a provable orphan. */
async function orphanOne(): Promise<{ workspaceId: string; runId: string }> {
  const { binding } = await stagePreparation(root);
  await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
  return { workspaceId: binding.workspaceId, runId: binding.runId };
}

/** A REAL signed crash-pending quarantine unit — not a synthetic directory. */
async function crashedQuarantineUnit(): Promise<string> {
  const { binding } = await stagePreparation(root);
  await tamperRun(root, binding);
  return crashQuarantine(root, binding, AT);
}

describe("the gate and the destructive executor read the same snapshot", () => {
  it("sweep deletes under state that would have refused it at the gate", async () => {
    // 1. An orphan for sweep to find, and a real signed pending quarantine unit.
    const orphan = await orphanOne();
    const unitId = await crashedQuarantineUnit();
    // A REAL byte witness: every file under the project's preparation store.
    const files = () => workspaceFileNames(root);
    const before = await files();

    // 2. HIDE the quarantine unit, so the gate's capture cannot see it.
    const hidden = path.join(root, ".llmwiki", "hidden-unit");
    await mkdir(path.dirname(hidden), { recursive: true });
    await rename(path.join(quarantineDir(), unitId), hidden);

    // 3. Acquire the sweep gate against that partial view — a clean fresh start.
    const acquisition = await acquirePreparationMutationLock(root, "sweep");
    expect(acquisition.acquired).toBe(true);
    if (!acquisition.acquired) return;
    expect(acquisition.authorization.ticket).toBeNull();

    // 4. RESTORE the signed unit while the lock is held.
    await rename(hidden, path.join(quarantineDir(), unitId));

    // 5. The lifecycle now reports it pending — the gate would refuse this.
    const pending = await resolvePreparationLifecyclePending(root);
    expect(pending.status).toBe("pending");

    // 6. Drive the executor with the ticket the gate authorized.
    let outcome: string;
    let thrown: unknown = null;
    try {
      const swept = await sweepPreparationOrphansLocked(root, {
        actor: LIFECYCLE_ACTOR, at: AT, authorization: acquisition.authorization,
      });
      outcome = swept.status;
    } catch (error) {
      thrown = error;
      outcome = `refused(${(error as Error).name})`;
    } finally {
      await releaseLock(root);
    }

    const after = await files();
    void stat;

    // THE WITNESS IS THE IDENTITY OF WHAT SURVIVED, NOT A COUNT. The first
    // version of this case counted entries under the preparations root -- a
    // number that did NOT move while two files were destroyed, because it was
    // taken at the wrong level. A count has to be at exactly the right level to
    // register a deletion; a list of paths cannot be at the wrong one.
    //
    // Before the fix this reported outcome=swept with the run's manifest and its
    // evidence object gone.
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

    // MUTATION EVIDENCE, compile-clean. Neutralizing the driver's
    // re-authorization in a TYPE-PRESERVING way -- taking the gate's own decision
    // as the current one without consulting the capture, so every symbol stays
    // referenced and typed -- keeps `tsc --noEmit` and the test type-check green
    // and makes this case fail because these two files were DELETED. The earlier
    // neutralization drew a narrowing complaint; a mutant that does not compile
    // can report "no reds" and "no tests" as the same result.
    expect(before.filter((file) => !after.includes(file))).toEqual([]);
    expect(outcome).not.toBe("swept");
  });
});
