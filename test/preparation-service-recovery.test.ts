/**
 * @file test/preparation-service-recovery.test.ts
 * @description The `recovery` operation's own behaviour at the service seam.
 *
 * THE PRECONDITION THIS FILE EXISTS FOR: stranded is not busy. The park clears
 * the execution owner, which is the fence a live executor's late result is
 * validated against — so parking a run whose executor is still running would
 * strip the fence out from under live work and turn a transient wait into
 * damage. The positive case and the live-owner case are written as a PAIR from
 * one builder differing in a single recorded field, because a suite holding only
 * the positive case is satisfied by a park that never checks liveness at all,
 * and a suite holding only the refusal is satisfied by one that parks nothing.
 *
 * AND THE ORDER IS POSITIVE-FIRST, deliberately: a guard whose only tests are
 * refusals is how this program's stranding defects were introduced.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { preparationKeyFile } from "../src/preparations/paths.js";
import type { RecoveryResultV1 } from "../src/preparations/service.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { driveToRecoveryRequired } from "./preparations/lifecycle-fixture.js";
import {
  CANCEL_RECOVERY_GRANTS, driveRunning, expectStillRunningWithOwner, readRun, serviceOn,
  stagedProject, strandedRun, type RunningRunFixture,
} from "./preparation-recovery-fixture.js";

/** Recover the fixture's run through a granted `sdk` service. */
function recover(fixture: RunningRunFixture, id = "host-2"): Promise<RecoveryResultV1> {
  return serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS, id).recovery({
    runId: fixture.binding.runId,
  });
}

/**
 * Drive one owner shape, recover it, and require the run to be LEFT ALONE.
 *
 * Shared by the two busy-owner cases because the assertion is the whole point
 * and must not drift between them: refused for the RIGHT reason, and the run
 * still exactly the running-with-owner record it was. `owner` is the only thing
 * that varies, which is what makes the pair discriminating.
 */
async function expectLeftAlone(
  fixture: RunningRunFixture, owner: "live" | "unsignalable", pid: RegExp,
): Promise<void> {
  await driveRunning(fixture, owner);
  const result = await recover(fixture);
  expect(result.status).toBe("refused");
  if (result.status === "refused") expect(result.reason).toMatch(pid);
  await expectStillRunningWithOwner(fixture);
}

describe("recovery parks a stranded run", () => {
  it("appends recovery-required, clears the owner, and marks the phase", async () => {
    const fixture = await strandedRun("recpark");
    try {
      const result = await recover(fixture);
      expect(result).toMatchObject({ status: "parked", runId: fixture.binding.runId });
      // READ OFF DISK, not from the DTO: the owner clearing is the durable half
      // and appears in no result field.
      const run = await readRun(fixture);
      expect(run.state).toBe("recovery-required");
      expect(run.executionOwner).toBeUndefined();
      expect(run.phaseSummaries[0]?.state).toBe("recovery-required");
    } finally { await fixture.cleanup(); }
  });

  it("credits the HOST principal on the durable park transition", async () => {
    const fixture = await strandedRun("recactor");
    try {
      await recover(fixture, "agent-9");
      const run = await readRun(fixture);
      // The actor comes from the captured principal, never from the request:
      // no request field carries one.
      expect(run.transitions[run.transitions.length - 1]?.actor)
        .toMatchObject({ id: "agent-9", surface: "sdk" });
    } finally { await fixture.cleanup(); }
  });

  it("reports an already-parked run rather than refusing an idempotent retry", async () => {
    const fixture = await stagedProject("recidem");
    try {
      await driveToRecoveryRequired(fixture.root, fixture.binding);
      expect(await recover(fixture))
        .toMatchObject({ status: "already-parked", runId: fixture.binding.runId });
    } finally { await fixture.cleanup(); }
  });
});

describe("recovery leaves a BUSY run alone", () => {
  it("refuses a run whose executor process is still LIVE, and touches nothing", async () => {
    // The sibling of the park test, differing in one recorded field. Deleting
    // the liveness test parks this run — clearing the fence a running executor's
    // late result is validated against.
    const fixture = await stagedProject("reclive");
    try {
      await expectLeftAlone(fixture, "live", /live executor \(pid \d+\)/u);
    } finally { await fixture.cleanup(); }
  });

  it("refuses a run whose executor this uid cannot SIGNAL, and touches nothing", async () => {
    // THE THIRD OWNER SHAPE, and the one the first version of this operation got
    // wrong. `kill(pid, 0)` throws ESRCH when a process is gone and EPERM when it
    // EXISTS but belongs to another uid; a liveness check reading both as death
    // calls a live foreign-uid executor a corpse and clears the fence its results
    // are validated against. Reachable whenever the executor and the operator are
    // different users — a service-account or daemon executor, a sudo-launched
    // compile, a CI runner's project directory.
    //
    // The owner here records the foreign process's REAL start time, so the
    // PID-reuse evidence agrees it is genuinely that process and the signal probe
    // is the only thing left deciding.
    const fixture = await stagedProject("recunsignalable");
    try {
      // The pid is pinned EXACTLY here — a generic `\d+` would also match this
      // test process, which is the case the sibling above already covers.
      await expectLeftAlone(fixture, "unsignalable", /live executor \(pid 1\)/u);
    } finally { await fixture.cleanup(); }
  });

  it("refuses a run in a state the park does not own, naming the state", async () => {
    const fixture = await stagedProject("recplanned");
    try {
      const result = await recover(fixture);
      expect(result).toMatchObject({
        status: "refused",
        reason: "only a run holding an execution owner can be parked for recovery; this run is planned",
      });
    } finally { await fixture.cleanup(); }
  });
});

describe("recovery reports what it observed of lifecycle maintenance", () => {
  it("carries a clean lifecycle projection alongside a park", async () => {
    const fixture = await strandedRun("reclifecycle");
    try {
      expect(await recover(fixture)).toMatchObject({ status: "parked", lifecycle: { status: "clean" } });
    } finally { await fixture.cleanup(); }
  });

  it("distinguishes NOT OBSERVED from unavailable when it refuses before the lock", async () => {
    // `null` is a third answer. A refusal that never reached the observation
    // must not report the project's maintenance state as unreadable — that would
    // be an unavailability claim manufactured out of a busy lock.
    const fixture = await stagedProject("reclockbusy");
    await acquireLock(fixture.root, { quiet: true });
    try {
      expect(await recover(fixture))
        .toEqual({ status: "refused", reason: "project lock is busy", lifecycle: null });
    } finally {
      await releaseLock(fixture.root);
      await fixture.cleanup();
    }
  });

  it("refuses on an unreadable project key, and stays usable once it is repaired", async () => {
    const fixture = await strandedRun("recnokey");
    try {
      const key = await readFile(preparationKeyFile(fixture.root));
      await writeFile(preparationKeyFile(fixture.root), "not a key", "utf8");
      const result = await recover(fixture);
      expect(result).toMatchObject({ status: "refused", lifecycle: null });
      if (result.status === "refused") expect(result.reason).toMatch(/preparation key is unreadable/u);
      // THE REFUSAL DOES NOT STRAND. Repairing the key and retrying reaches the
      // park, which also proves the refused call committed nothing — a run it
      // had half-moved could not park cleanly afterwards.
      await writeFile(preparationKeyFile(fixture.root), key);
      expect(await recover(fixture)).toMatchObject({ status: "parked" });
      expect((await readRun(fixture)).state).toBe("recovery-required");
    } finally { await fixture.cleanup(); }
  });
});
