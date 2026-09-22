/**
 * @file test/preparation-cancel-recovery-faults.test.ts
 * @description A fault injected at every durable boundary these two operations
 * cross, and the two properties that matter at each: NOTHING PARTIAL is left
 * behind, and the project is still USABLE once the fault clears.
 *
 * THE BOUNDARIES ARE ENUMERATED FROM THE OPERATIONS, not guessed. `cancel`
 * crosses exactly one — the create-only advisory publication. `recovery` crosses
 * exactly one — the projected `recovery-required` append that also clears the
 * execution owner. Everything else either operation does is a read.
 *
 * THE FAULT IS THE DIRECTORY, deliberately, rather than a stubbed writer. A
 * mocked failure proves the code's own catch arm; an unwritable runs directory
 * fails the REAL primitive — the temp create, the link, the fsync — at whichever
 * step it actually reaches, which is the failure a full disk or a revoked
 * permission produces.
 *
 * THE SECOND ASSERTION IN EACH CASE IS THE LOAD-BEARING ONE. A throw alone is
 * satisfied by an operation that committed and then failed on the way out; the
 * durable re-read is what tells a refusal from a half-completed write, and the
 * post-repair retry is what proves the fault left the project recoverable rather
 * than wedged.
 */

import { chmod } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readPreparationCancel } from "../src/preparations/cancellation.js";
import { preparationPaths } from "../src/preparations/paths.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import {
  CANCEL_RECOVERY_GRANTS, driveRunning, readRun, serviceOn, stagedProject, strandedRun,
  type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

let fixture: RunningRunFixture | undefined;

afterEach(async () => {
  // Restored before cleanup, or the temp-root removal cannot unlink the leaves.
  if (fixture !== undefined) await writable(fixture, true).catch(() => {});
  await fixture?.cleanup();
  fixture = undefined;
});

/** Make the directory both durable boundaries publish into unwritable, or not. */
async function writable(target: RunningRunFixture, allowed: boolean): Promise<void> {
  const { runsRoot } = preparationPaths(target.root, target.binding.workspaceId);
  await chmod(runsRoot, allowed ? 0o700 : 0o500);
}

/** The service both suites drive, on the surface where grants have content. */
function service(target: RunningRunFixture) {
  return serviceOn(target.root, "sdk", CANCEL_RECOVERY_GRANTS);
}

/**
 * Run one operation against an unwritable store, require it to fail, and repair.
 *
 * A raw I/O fault is not a domain refusal and is deliberately not dressed up as
 * one: the declared `refused` arm means "this project state does not qualify",
 * and reporting an unwritable disk through it would tell a caller their request
 * was considered and declined.
 */
async function underWriteFault(target: RunningRunFixture, run: () => Promise<unknown>): Promise<void> {
  await writable(target, false);
  await expect(run()).rejects.toThrow();
  await writable(target, true);
}

describe("a fault at cancel's durable boundary", () => {
  it("publishes nothing when the advisory cannot be written, and works after repair", async () => {
    fixture = await stagedProject("faultcancelwrite");
    const runId = fixture.binding.runId;
    const target = fixture;

    await underWriteFault(target, () => service(target).cancel({ runId }));

    const read = await readPreparationCancel(target.root, target.binding.workspaceId, runId);
    // NOTHING PARTIAL. Not even an unreadable residue that a later call would
    // classify as a planted object and refuse over.
    expect(read.status).toBe("absent");
    expect(await service(target).cancel({ runId })).toMatchObject({ status: "requested", request: "created" });
  });
});

describe("a fault at recovery's durable boundary", () => {
  it("leaves the run exactly as it was, and parks it after repair", async () => {
    fixture = await strandedRun("faultrecappend");
    const runId = fixture.binding.runId;
    const target = fixture;

    await underWriteFault(target, () => service(target).recovery({ runId }));

    const unchanged = await readRun(target);
    // STILL THE ZOMBIE IT WAS: state and owner both intact. A park that had
    // half-written would show up here as a cleared owner on a `running` run —
    // the exact state the park exists to prevent.
    expect(unchanged.state).toBe("running");
    expect(unchanged.executionOwner).toBeDefined();
    expect(await service(target).recovery({ runId })).toMatchObject({ status: "parked" });
    expect((await readRun(target)).state).toBe("recovery-required");
  });

  it("releases the project lock on the way out, so the next call is not blocked", async () => {
    // The `finally` release is what makes the retry above possible at all.
    // Without it the failed acquisition would hold the lock for the process's
    // lifetime and every later operation would refuse "project lock is busy" —
    // a fault converted into a permanent wedge.
    fixture = await stagedProject("faultreclock");
    await driveRunning(fixture, "stranded");
    const target = fixture;

    await underWriteFault(target, () => service(target).recovery({ runId: target.binding.runId }));

    // Probed with the RAW lock rather than another operation: the lock is what
    // the claim is about, and a verb that refuses for its own reasons before
    // acquiring would report "not blocked" without ever testing it.
    expect(await acquireLock(target.root, { quiet: true })).toBe(true);
    await releaseLock(target.root);
  });
});
